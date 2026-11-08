// Camera streams recorded as video (foxglove_msgs.CompressedVideo: H.264/H.265 access units) rather than as stills.
//
// A video frame is not a picture on its own. Only a keyframe decodes by itself; every frame after it is stored as the
// difference from the ones before, so handing ffmpeg the single message the playhead lands on renders NOTHING (it
// exits non-zero and writes no bytes). To show frame `i` we therefore feed it everything from the last keyframe up to
// `i` and keep the last picture that comes out.
//
// That is the whole trick, and it is why these streams looked broken: the rest of the Replayer reads one message and
// decodes it, which is right for stills and impossible for video.
import type { Source, StreamMeta } from "./source.ts"
import type { ImageFrame } from "./payload.ts"
import { decodeObject } from "./payload.ts"

/** foxglove_msgs.CompressedVideo, and anything else that ends in CompressedVideo */
export const isVideoType = (type: string) => /(^|\.)CompressedVideo$/.test(type)

/** how far back to look for a keyframe before giving up (a camera sends one every second or two) */
const MAX_GOP = 300

/**
 * Annex-B NAL units: each starts with 00 00 01 or 00 00 00 01. Returns the type bytes found, which is all we need to
 * tell a keyframe from the rest. H.264 keeps the type in the low 5 bits of one byte; H.265 in bits 1-6 of the first.
 */
function nalTypes(bytes: Uint8Array, h265: boolean): number[] {
    const types: number[] = []
    for (let i = 0; i + 3 < bytes.length; i++) {
        if (bytes[i] !== 0 || bytes[i + 1] !== 0) {
            continue
        }
        const at = bytes[i + 2] === 1 ? i + 3 : (bytes[i + 2] === 0 && bytes[i + 3] === 1 ? i + 4 : -1)
        if (at < 0 || at >= bytes.length) {
            continue
        }
        types.push(h265 ? (bytes[at] >> 1) & 0x3f : bytes[at] & 0x1f)
    }
    return types
}

/** H.264: IDR is 5. H.265: the IRAP types (BLA/IDR/CRA) are 16-23. */
export function isKeyframe(bytes: Uint8Array, h265: boolean): boolean {
    return nalTypes(bytes, h265).some((type) => h265 ? (type >= 16 && type <= 23) : type === 5)
}

/** the `format` field of a CompressedVideo message ("h264", "h265", "av1", ...) */
function formatOf(message: Record<string, unknown> | null): string {
    return String(message?.format ?? "h264").toLowerCase()
}

/** the access unit bytes of one message, or null when it is not a video message after all */
export function unitOf(meta: StreamMeta, raw: Uint8Array): { data: Uint8Array; format: string; frame: string } | null {
    const message = decodeObject(meta, raw) as Record<string, unknown> | null
    const data = message?.data
    if (!data) {
        return null
    }
    return {
        data: data instanceof Uint8Array ? data : new Uint8Array(data as ArrayLike<number>),
        format: formatOf(message),
        frame: String(message?.frame_id ?? ""),
    }
}

/** ffmpeg's name for a bare stream of access units */
const demuxer = (format: string) => (format.includes("265") || format.includes("hevc") ? "hevc" : "h264")

/**
 * Decode `units` (a keyframe first, then the frames after it) and return EVERY picture ffmpeg wrote, in order.
 *
 * Getting all of them matters: reaching frame N means decoding the whole group up to it anyway, and ffmpeg emits a
 * picture per frame while doing so. Keeping them makes playing forward through the group free, instead of redecoding
 * from the keyframe for each one (which is quadratic in the group's length).
 */
export async function decodeUnits(units: Uint8Array[], format: string, width = 0): Promise<Uint8Array[]> {
    const total = units.reduce((n, unit) => n + unit.length, 0)
    const stream = new Uint8Array(total)
    let at = 0
    for (const unit of units) {
        stream.set(unit, at)
        at += unit.length
    }
    const scale = width > 0 ? ["-vf", `scale=${width}:-2`] : []
    const child = new Deno.Command("ffmpeg", {
        args: [
            "-v",
            "error",
            "-f",
            demuxer(format),
            "-i",
            "pipe:0",
            ...scale,
            "-f",
            "image2pipe",
            "-vcodec",
            "mjpeg",
            "pipe:1",
        ],
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
    }).spawn()
    const writer = child.stdin.getWriter()
    await writer.write(stream).catch(() => {})
    await writer.close().catch(() => {})
    const out = await child.output()
    return splitJpegs(out.stdout)
}

/** every jpeg in a concatenated mjpeg stream: each runs from its start marker (FF D8) to its end marker (FF D9) */
export function splitJpegs(bytes: Uint8Array): Uint8Array[] {
    const out: Uint8Array[] = []
    let start = -1
    for (let i = 0; i + 1 < bytes.length; i++) {
        if (bytes[i] !== 0xff) {
            continue
        }
        if (bytes[i + 1] === 0xd8 && start < 0) {
            start = i
        } else if (bytes[i + 1] === 0xd9 && start >= 0) {
            out.push(bytes.slice(start, i + 2))
            start = -1
        }
    }
    return out
}

/**
 * Turns a recorded video stream into pictures. One per subscription: it remembers the keyframe it last decoded from,
 * so playing forward inside a group of frames does not re-read the whole group from the recording every time.
 */
export class VideoFrames {
    #source: Source
    #meta: StreamMeta
    /** index of the keyframe the current group starts at (-1: nothing read yet) */
    #from = -1
    /** the access units of that group, and the index after the last one read */
    #units: Uint8Array[] = []
    #next = 0
    #format = "h264"
    #frame = ""
    /** the pictures decoded for this group so far, and the width they were decoded at */
    #pictures: Uint8Array[] = []
    #picturesWidth = -1

    constructor(source: Source, meta: StreamMeta) {
        this.#source = source
        this.#meta = meta
    }

    /** the picture for message `i`, as a jpeg ImageFrame, or null when it cannot be decoded */
    async frameAt(i: number, width = 0): Promise<ImageFrame | null> {
        const at = await this.#reach(i)
        if (at < 0) {
            return null
        }
        const offset = at - this.#from
        if (width !== this.#picturesWidth) {
            this.#pictures = []
            this.#picturesWidth = width
        }
        // playing forward inside a group: this picture came out of the decode done for an earlier frame
        let data = this.#pictures[offset]
        if (!data) {
            const pictures = await decodeUnits(this.#units.slice(0, offset + 1), this.#format, width)
            if (!pictures.length) {
                return null
            }
            // ffmpeg writes one picture per frame it decoded, in order from the keyframe
            this.#pictures = pictures
            data = pictures[offset] ?? pictures[pictures.length - 1]
        }
        return { kind: "image", frame: this.#frame, width: 0, height: 0, encoding: "jpeg", data }
    }

    /**
     * Read whatever it takes to have every access unit from the group's keyframe through `i`. Returns the message the
     * picture will be of -- `i` itself, or the next keyframe when `i` is before the recording's first one -- or -1.
     *
     * A recorder subscribes whenever the user presses record, so a recording usually starts in the middle of a group:
     * its first frames have no keyframe before them and cannot be decoded at all. Showing the next keyframe instead of
     * nothing is what makes the start of such a stream, and its preview, appear.
     */
    async #reach(i: number): Promise<number> {
        if (i < 0) {
            return -1
        }
        // a seek backwards out of the group, or nothing read yet: find the keyframe at or before `i`
        if (this.#from < 0 || i < this.#from) {
            const before = await this.#keyframeAtOrBefore(i)
            const first = before >= 0 ? before : await this.#keyframeAfter(i)
            if (first < 0) {
                return -1
            }
            this.#startAt(first)
        }
        // then extend forward, one read per message; a keyframe along the way opens a new group
        const want = Math.max(i, this.#from)
        while (this.#next <= want) {
            const unit = await this.#unitAt(this.#next)
            if (!unit) {
                return -1
            }
            if (this.#next > this.#from && isKeyframe(unit.data, this.#h265())) {
                this.#startAt(this.#next)
            }
            this.#units[this.#next - this.#from] = unit.data
            this.#next++
        }
        return this.#units.length > 0 ? want : -1
    }

    #startAt(index: number) {
        this.#from = index
        this.#next = index
        this.#units = []
        this.#pictures = []
    }

    #h265() {
        return this.#format.includes("265") || this.#format.includes("hevc")
    }

    async #unitAt(index: number) {
        const unit = unitOf(this.#meta, await this.#source.read(this.#meta.name, index))
        if (unit) {
            this.#format = unit.format
            this.#frame = unit.frame
        }
        return unit
    }

    /** scan back from `i` for the newest keyframe (bounded: a stream with none would read the whole file) */
    async #keyframeAtOrBefore(i: number): Promise<number> {
        for (let at = i; at >= 0 && i - at < MAX_GOP; at--) {
            const unit = await this.#unitAt(at)
            if (!unit) {
                return -1
            }
            if (isKeyframe(unit.data, this.#h265())) {
                return at
            }
        }
        return -1
    }

    /** scan forward from after `i` for the next keyframe, for frames with none before them (same bound) */
    async #keyframeAfter(i: number): Promise<number> {
        for (let at = Math.max(0, i) + 1; at - i <= MAX_GOP; at++) {
            // past the end of the stream, which a read reports however the recording's format does
            const unit = await this.#unitAt(at).catch(() => null)
            if (!unit) {
                return -1
            }
            if (isKeyframe(unit.data, this.#h265())) {
                return at
            }
        }
        return -1
    }
}

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
function unitOf(meta: StreamMeta, raw: Uint8Array): { data: Uint8Array; format: string; frame: string } | null {
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
 * Decode `units` (a keyframe first, then the frames after it) and return the LAST picture as a jpeg. ffmpeg reads the
 * access units on stdin and writes jpegs on stdout; we keep the final one, which is the frame that was asked for.
 */
async function decodeUnits(units: Uint8Array[], format: string, width: number): Promise<Uint8Array | null> {
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
    if (!out.stdout.length) {
        return null
    }
    return lastJpeg(out.stdout)
}

/** the last jpeg in a concatenated mjpeg stream (each starts FF D8 FF) */
export function lastJpeg(bytes: Uint8Array): Uint8Array | null {
    let start = -1
    for (let i = 0; i + 2 < bytes.length; i++) {
        if (bytes[i] === 0xff && bytes[i + 1] === 0xd8 && bytes[i + 2] === 0xff) {
            start = i
        }
    }
    return start < 0 ? null : bytes.slice(start)
}

/**
 * Turns a recorded video stream into pictures. One per subscription: it remembers the keyframe it last decoded from,
 * so playing forward inside a group of frames does not re-read the whole group from the recording every time.
 */
export class VideoFrames {
    #source: Source
    #meta: StreamMeta
    /** index of the keyframe at or before the frame decoded last, and the units read from it */
    #from = -1
    #units: Uint8Array[] = []
    #format = "h264"

    constructor(source: Source, meta: StreamMeta) {
        this.#source = source
        this.#meta = meta
    }

    /** the picture for message `i`, as a jpeg ImageFrame, or null when it cannot be decoded */
    async frameAt(i: number, width = 0): Promise<ImageFrame | null> {
        const units = await this.#unitsTo(i)
        if (!units) {
            return null
        }
        const data = await decodeUnits(units.units, units.format, width)
        if (!data) {
            return null
        }
        return { kind: "image", frame: units.frame, width: 0, height: 0, encoding: "jpeg", data }
    }

    /** every access unit from the keyframe at or before `i` through `i` */
    async #unitsTo(i: number): Promise<{ units: Uint8Array[]; format: string; frame: string } | null> {
        const first = await this.#keyframeAtOrBefore(i)
        if (first < 0) {
            return null
        }
        // reuse what we already read when playing forward from the same keyframe
        if (first !== this.#from) {
            this.#from = first
            this.#units = []
        }
        let frame = ""
        for (let at = first; at <= i; at++) {
            const have = this.#units[at - first]
            if (have) {
                continue
            }
            const unit = unitOf(this.#meta, await this.#source.read(this.#meta.name, at))
            if (!unit) {
                return null
            }
            this.#units[at - first] = unit.data
            this.#format = unit.format
            frame = unit.frame
        }
        return { units: this.#units.slice(0, i - first + 1), format: this.#format, frame }
    }

    /** scan back from `i` for the newest keyframe (bounded: a stream with none would otherwise read the whole file) */
    async #keyframeAtOrBefore(i: number): Promise<number> {
        const h265 = this.#format.includes("265") || this.#format.includes("hevc")
        for (let at = i; at >= 0 && i - at < MAX_GOP; at--) {
            const unit = unitOf(this.#meta, await this.#source.read(this.#meta.name, at))
            if (!unit) {
                return -1
            }
            this.#format = unit.format
            if (isKeyframe(unit.data, h265 || unit.format.includes("265") || unit.format.includes("hevc"))) {
                return at
            }
        }
        return -1
    }
}

// Scrubbing thumbnails for encoded (jpeg/png) camera streams: a small jpeg every quarter second, made in the background
// by one ffmpeg per stream (nice'd) when a recording is first played, kept on disk under the app data dir (one file of
// jpegs + an index per stream) and reused next time. Raw streams (mono8, rgb8, depth) need none: the player thins
// their pixels on the fly. While a track is still being made, the part made so far is used.
import { join } from "node:path"
import { decodeImage, type ImageFrame } from "./payload.ts"
import type { Source } from "./source.ts"
import { ffmpeg } from "../recordings/thumbnails.ts"
import { which } from "../recordings/foxglove.ts"
import { afterPages } from "./player.ts"

/** at most one thumbnail per this many seconds */
export const THUMB_SPACING = 0.25
export const THUMB_WIDTH = 192
/** all recordings' scrubbing thumbnails together stay under this; the least recently used go first */
export const THUMBS_BUDGET_BYTES = 256 * 1024 * 1024

/** Deletes the least recently used thumbnail folders under `root` until the rest fit the budget. */
export function pruneThumbs(root: string, keep: string, budget = THUMBS_BUDGET_BYTES) {
    let folders: { path: string; bytes: number; used: number }[] = []
    try {
        folders = [...Deno.readDirSync(root)].filter((entry) => entry.isDirectory).map((entry) => {
            const path = join(root, entry.name)
            let bytes = 0
            let used = 0
            for (const file of Deno.readDirSync(path)) {
                const stat = Deno.statSync(join(path, file.name))
                bytes += stat.size
                used = Math.max(used, stat.mtime?.getTime() ?? 0)
            }
            return { path, bytes, used }
        })
    } catch {
        return
    }
    let total = folders.reduce((sum, folder) => sum + folder.bytes, 0)
    for (const folder of folders.sort((a, b) => a.used - b.used)) {
        if (total <= budget) {
            break
        }
        if (folder.path === keep) {
            continue
        }
        Deno.removeSync(folder.path, { recursive: true })
        total -= folder.bytes
    }
}

type Track = {
    times: number[]
    offsets: number[]
    lengths: number[]
    width: number
    height: number
    done: boolean
    file: string
}

export class Thumbs {
    #tracks = new Map<string, Track>()
    #working: Promise<void> | null = null
    #stopped = false
    /** progress for GET api/replay/{id}: stream → share done */
    progress: Record<string, number> = {}

    constructor(readonly dir: string, readonly source: Source) {
        Deno.mkdirSync(dir, { recursive: true })
        pruneThumbs(join(dir, ".."), dir)
    }

    stop() {
        this.#stopped = true
    }

    /** Starts making the tracks this recording is missing (once). */
    start() {
        if (!ffmpeg()) {
            return
        }
        this.#working ??= this.#makeAll().catch((error) => console.error("replay thumbnails:", error))
    }

    async #makeAll() {
        for (const meta of this.source.streams) {
            if (meta.kind !== "image" || meta.count === 0 || this.#stopped) {
                continue
            }
            const indexFile = join(this.dir, `${safe(meta.name)}.json`)
            try {
                const saved = JSON.parse(await Deno.readTextFile(indexFile)) as Track
                if (saved.done) {
                    this.#tracks.set(meta.name, {
                        ...saved,
                        file: join(this.dir, `${safe(meta.name)}.jpgs`),
                    })
                    this.progress[meta.name] = 1
                    continue
                }
            } catch {
                // not made yet
            }
            const first = decodeImage(meta, await this.source.read(meta.name, 0))
            if (!first || !["jpeg", "png", "webp"].includes(first.encoding)) {
                continue // raw pixels: thinned on the fly instead
            }
            await this.#make(meta.name, first.encoding)
        }
    }

    async #make(stream: string, encoding: string) {
        const meta = this.source.streams.find((s) => s.name === stream)!
        const { times } = await this.source.index(stream)
        const picked: number[] = []
        let last = -Infinity
        for (let i = 0; i < times.length; i++) {
            if (times[i] - last >= THUMB_SPACING) {
                picked.push(i)
                last = times[i]
            }
        }
        const file = join(this.dir, `${safe(stream)}.jpgs`)
        const track: Track = {
            times: [],
            offsets: [],
            lengths: [],
            width: 0,
            height: 0,
            done: false,
            file,
        }
        this.#tracks.set(stream, track)
        const output = await Deno.open(file, {
            write: true,
            create: true,
            truncate: true,
        })
        const nice = which("nice")
        const args = [
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "image2pipe",
            "-c:v",
            encoding === "png" ? "png" : encoding === "webp" ? "webp" : "mjpeg",
            "-i",
            "pipe:0",
            "-vf",
            `scale=${THUMB_WIDTH}:-2:flags=area`,
            "-fps_mode",
            "passthrough",
            "-q:v",
            "7",
            "-f",
            "image2pipe",
            "-c:v",
            "mjpeg",
            "pipe:1",
        ]
        const child = new Deno.Command(nice ?? ffmpeg()!, {
            args: nice ? ["-n", "19", ffmpeg()!, ...args] : args,
            stdin: "piped",
            stdout: "piped",
            stderr: "null",
        }).spawn()
        let written = 0
        let produced = 0
        const reading = (async () => {
            let buffer = new Uint8Array(0)
            for await (const piece of child.stdout) {
                const joined = new Uint8Array(buffer.length + piece.length)
                joined.set(buffer)
                joined.set(piece, buffer.length)
                buffer = joined
                for (;;) {
                    const end = jpegEnd(buffer)
                    if (end < 0) {
                        break
                    }
                    const jpeg = buffer.subarray(0, end)
                    if (!track.width) {
                        const size = jpegSize(jpeg)
                        track.width = size.width
                        track.height = size.height
                    }
                    await output.write(jpeg)
                    track.offsets.push(written)
                    track.lengths.push(jpeg.length)
                    track.times.push(times[picked[produced]])
                    written += jpeg.length
                    produced++
                    this.progress[stream] = produced / picked.length
                    buffer = buffer.slice(end)
                }
            }
        })()
        const writer = child.stdin.getWriter()
        try {
            for (const i of picked) {
                if (this.#stopped) {
                    break
                }
                await afterPages()
                const image = decodeImage(meta, await this.source.read(stream, i))
                await writer.write(image?.data ?? new Uint8Array(0))
            }
        } catch (error) {
            console.error(`replay thumbnails for ${stream}:`, error)
        } finally {
            await writer.close().catch(() => {})
        }
        await child.status
        await reading
        output.close()
        track.done = produced === picked.length && !this.#stopped
        if (track.done) {
            const { file: _file, ...saved } = track
            await Deno.writeTextFile(
                join(this.dir, `${safe(stream)}.json`),
                JSON.stringify(saved),
            )
        }
    }

    /** The thumbnail at or just before t, or null (no track, or not made that far yet). */
    async near(stream: string, t: number): Promise<ImageFrame | null> {
        const track = this.#tracks.get(stream)
        if (!track || track.times.length === 0) {
            return null
        }
        let low = 0, high = track.times.length - 1, found = -1
        while (low <= high) {
            const middle = (low + high) >> 1
            if (track.times[middle] <= t) {
                found = middle
                low = middle + 1
            } else {
                high = middle - 1
            }
        }
        if (found < 0) {
            found = 0
        }
        if (
            !track.done && found === track.times.length - 1 &&
            t - track.times[found] > THUMB_SPACING * 4
        ) {
            return null // past what's made so far
        }
        const file = await Deno.open(track.file, { read: true })
        try {
            const data = new Uint8Array(track.lengths[found])
            await file.seek(track.offsets[found], Deno.SeekMode.Start)
            let filled = 0
            while (filled < data.length) {
                const got = await file.read(data.subarray(filled))
                if (got === null) {
                    break
                }
                filled += got
            }
            return {
                kind: "image",
                frame: "",
                width: track.width,
                height: track.height,
                encoding: "jpeg",
                data,
            }
        } finally {
            file.close()
        }
    }
}

function safe(name: string) {
    return name.replace(/[^A-Za-z0-9_.-]/g, "_")
}

/** End (exclusive) of the first complete JPEG in `bytes` (its EOI marker), or -1. */
function jpegEnd(bytes: Uint8Array): number {
    for (let i = 2; i + 1 < bytes.length; i++) {
        if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) {
            return i + 2
        }
    }
    return -1
}

function jpegSize(data: Uint8Array): { width: number; height: number } {
    let at = 2
    while (at + 9 < data.length) {
        if (data[at] !== 0xff) {
            at++
            continue
        }
        const marker = data[at + 1]
        const length = (data[at + 2] << 8) | data[at + 3]
        if (
            marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 &&
            marker !== 0xcc
        ) {
            return {
                height: (data[at + 5] << 8) | data[at + 6],
                width: (data[at + 7] << 8) | data[at + 8],
            }
        }
        at += 2 + length
    }
    return { width: 0, height: 0 }
}

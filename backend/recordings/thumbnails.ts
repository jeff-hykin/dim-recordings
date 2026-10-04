// Preview clips: a background job that picks each recording's main camera (RGB before grayscale before depth, then
// the highest resolution) and saves 15 small frames from its start, middle and end as one sprite (frames side by
// side), which the list plays and scrubs. Deliberately slow: one recording at a time, ffmpeg under `nice -n 19`, a
// pause between frames and between recordings. Each finished recording logs its wall and CPU time.
import { openDb } from "./sqlite.ts"
import { join } from "node:path"
import process from "node:process"
import type { Inspection, StreamInfo } from "./inspect.ts"
import { openMcap } from "./mcap.ts"
import { decodeCdrImage, type DecodedImage, decodeLcmCompressedImage, decodeLcmImage, unwrapBlob } from "./messages.ts"
import { which } from "./foxglove.ts"

export const FRAMES = 15
export const WIDTH = 320
const PAUSE_BETWEEN_FRAMES_MS = 250
const PAUSE_BETWEEN_RECORDINGS_MS = 2000

export type ThumbMeta = {
    frames: number
    width: number
    height: number
    stream: string
    encoding: string
    source: { width: number; height: number }
    times: number[]
    stats: { wallSeconds: number; appCpuSeconds: number; ffmpegRuns: number }
}

const DEPTH_ENCODINGS = new Set(["16uc1", "mono16", "32fc1", "16sc1"])
const GRAY_ENCODINGS = new Set(["mono8", "8uc1"])

/** 0 = color, 1 = grayscale, 2 = depth: the main camera is the lowest class, then the most pixels. */
export function imageClass(name: string, encoding: string): number {
    const lower = encoding.toLowerCase()
    if (DEPTH_ENCODINGS.has(lower) || /depth/i.test(name)) {
        return 2
    }
    if (GRAY_ENCODINGS.has(lower) || /(gray|grey|mono|infra|(^|_)ir(_|$))/i.test(name)) {
        return 1
    }
    return 0
}

export type Candidate = { name: string; encoding: string; width: number; height: number; count: number }

export function pickMainCamera(candidates: Candidate[]): Candidate | null {
    const ranked = [...candidates].filter((c) => c.count > 0).sort((a, b) =>
        imageClass(a.name, a.encoding) - imageClass(b.name, b.encoding) ||
        b.width * b.height - a.width * a.height ||
        b.count - a.count ||
        a.name.localeCompare(b.name)
    )
    return ranked[0] ?? null
}

/** 15 times: five spread over the first tenth, five around the middle, five over the last tenth. */
export function frameTimes(start: number, end: number, frames = FRAMES): number[] {
    const span = Math.max(0, end - start)
    const perSegment = Math.floor(frames / 3)
    const segments = [[0, 0.1], [0.45, 0.55], [0.9, 1]]
    const times: number[] = []
    for (const [from, to] of segments) {
        for (let i = 0; i < perSegment; i++) {
            const fraction = from + (to - from) * (perSegment === 1 ? 0.5 : i / (perSegment - 1))
            times.push(start + span * fraction)
        }
    }
    return times
}

/** Width and height of a JPEG (its SOF marker) or PNG (IHDR); 0x0 when unknown. */
export function compressedSize(data: Uint8Array): { width: number; height: number } {
    if (data[0] === 0x89 && data[1] === 0x50) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
        return { width: view.getUint32(16), height: view.getUint32(20) }
    }
    let at = 2
    while (at + 9 < data.length) {
        if (data[at] !== 0xff) {
            at++
            continue
        }
        const marker = data[at + 1]
        const length = (data[at + 2] << 8) | data[at + 3]
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { height: (data[at + 5] << 8) | data[at + 6], width: (data[at + 7] << 8) | data[at + 8] }
        }
        at += 2 + length
    }
    return { width: 0, height: 0 }
}

/** A frame source over one recording: a stream's image at (or just after) a time. */
type Source = {
    candidates(): Promise<Candidate[]>
    frameAt(stream: string, time: number): Promise<DecodedImage | null>
    close(): void
}

function withSize(image: DecodedImage): DecodedImage {
    return image.compressed && !image.width ? { ...image, ...compressedSize(image.data) } : image
}

function isImageStream(stream: StreamInfo) {
    return /(^|\.)(Image|CompressedImage)$/.test(stream.type) && stream.count > 0
}

function dbSource(path: string, inspection: Inspection): Source {
    const db = openDb(path)
    const decode = (blob: Uint8Array) => withSize(decodeLcmImage(unwrapBlob(new Uint8Array(blob))))
    const frameAt = (stream: string, time: number) => {
        const quoted = stream.replaceAll('"', '""')
        const row = db.prepare(
            `SELECT b.data AS data FROM "${quoted}" AS s JOIN "${quoted}_blob" AS b ON b.id = s.id WHERE s.ts >= ? ORDER BY s.ts LIMIT 1`,
        ).get(time) as { data: Uint8Array } | undefined
        return Promise.resolve(row ? decode(row.data) : null)
    }
    return {
        async candidates() {
            const out: Candidate[] = []
            for (const stream of inspection.streams.filter(isImageStream)) {
                try {
                    const first = await frameAt(stream.name, stream.start ?? 0)
                    if (first) {
                        out.push({
                            name: stream.name,
                            encoding: first.encoding,
                            width: first.width,
                            height: first.height,
                            count: stream.count,
                        })
                    }
                } catch {
                    // a stream whose blobs aren't in this file, or a payload this decoder doesn't know
                }
            }
            return out
        },
        frameAt,
        close: () => db.close(),
    }
}

async function mcapSource(path: string, inspection: Inspection): Promise<Source> {
    const mcap = await openMcap(path)
    const { reader } = mcap
    const channelOf = (name: string) =>
        [...reader.channelsById.values()].find((c) => c.topic.replace(/^\//, "") === name)
    const decode = (name: string, data: Uint8Array): DecodedImage => {
        const channel = channelOf(name)!
        const schema = reader.schemasById.get(channel.schemaId)
        if (channel.messageEncoding === "cdr" && schema) {
            return withSize(decodeCdrImage(schema.name, new TextDecoder().decode(schema.data), data))
        }
        const type = schema?.name ?? channel.metadata.get("type") ?? channel.metadata.get("lcm_type") ?? ""
        return withSize(/Compressed/.test(type) ? decodeLcmCompressedImage(data) : decodeLcmImage(data))
    }
    const frameAt = async (stream: string, time: number) => {
        const channel = channelOf(stream)
        if (!channel) {
            return null
        }
        for await (
            const message of reader.readMessages({ topics: [channel.topic], startTime: BigInt(Math.round(time * 1e9)) })
        ) {
            return decode(stream, message.data)
        }
        return null
    }
    return {
        async candidates() {
            const out: Candidate[] = []
            for (const stream of inspection.streams.filter(isImageStream)) {
                try {
                    const first = await frameAt(stream.name, stream.start ?? 0)
                    if (first) {
                        out.push({
                            name: stream.name,
                            encoding: first.encoding,
                            width: first.width,
                            height: first.height,
                            count: stream.count,
                        })
                    }
                } catch {
                    // undecodable channel
                }
            }
            return out
        },
        frameAt,
        close: () => mcap.close(),
    }
}

const PIXEL_FORMATS: Record<string, string> = {
    rgb8: "rgb24",
    bgr8: "bgr24",
    rgba8: "rgba",
    bgra8: "bgra",
    mono8: "gray",
    "8uc1": "gray",
    "8uc3": "bgr24",
    yuv422: "uyvy422",
    uyvy: "uyvy422",
    yuyv: "yuyv422",
    "yuv422_yuy2": "yuyv422",
}

/** 16-bit (mm) or float (m) depth squashed to 8-bit gray over 0..8 m, so the clip is watchable. */
function depthToGray(image: DecodedImage): Uint8Array {
    const pixels = image.width * image.height
    const out = new Uint8Array(pixels)
    const view = new DataView(image.data.buffer, image.data.byteOffset, image.data.byteLength)
    const float = image.encoding.toLowerCase() === "32fc1"
    for (let i = 0; i < pixels; i++) {
        const meters = float ? view.getFloat32(i * 4, true) : view.getUint16(i * 2, true) / 1000
        out[i] = !(meters > 0) ? 0 : Math.min(255, Math.round((1 - Math.min(meters, 8) / 8) * 255))
    }
    return out
}

let ffmpegPath: string | null | undefined
let nicePath: string | null | undefined
export function ffmpeg(): string | null {
    if (ffmpegPath === undefined) {
        ffmpegPath = Deno.env.get("DIM_RECORDINGS_FFMPEG") ?? which("ffmpeg")
    }
    return ffmpegPath
}

async function run(args: string[], input: Uint8Array): Promise<void> {
    if (nicePath === undefined) {
        nicePath = which("nice") ?? (Deno.build.os !== "windows" ? "/usr/bin/nice" : null)
    }
    const program = ffmpeg()!
    const command = nicePath
        ? new Deno.Command(nicePath, {
            args: ["-n", "19", program, ...args],
            stdin: "piped",
            stdout: "null",
            stderr: "piped",
        })
        : new Deno.Command(program, { args, stdin: "piped", stdout: "null", stderr: "piped" })
    const child = command.spawn()
    const writer = child.stdin.getWriter()
    await writer.write(input).catch(() => {})
    await writer.close().catch(() => {})
    const { success, stderr } = await child.output()
    if (!success) {
        throw new Error(`ffmpeg: ${new TextDecoder().decode(stderr).trim().split("\n").pop()}`)
    }
}

/** One frame → a WIDTH-wide jpeg at `out`. */
export async function writeFrame(image: DecodedImage, out: string) {
    const scale = ["-vf", `scale=${WIDTH}:-2:flags=area`, "-frames:v", "1", "-q:v", "6", "-y", out]
    const quiet = ["-hide_banner", "-loglevel", "error"]
    if (image.compressed) {
        await run([...quiet, "-f", "image2pipe", "-i", "pipe:0", ...scale], image.data)
        return
    }
    const encoding = image.encoding.toLowerCase()
    let pixelFormat = PIXEL_FORMATS[encoding]
    let data = image.data
    if (DEPTH_ENCODINGS.has(encoding)) {
        pixelFormat = "gray"
        data = depthToGray(image)
    }
    if (!pixelFormat) {
        throw new Error(`no thumbnail for ${image.encoding} images`)
    }
    await run([
        ...quiet,
        "-f",
        "rawvideo",
        "-pix_fmt",
        pixelFormat,
        "-s",
        `${image.width}x${image.height}`,
        "-i",
        "pipe:0",
        ...scale,
    ], data)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Builds the sprite for one recording into `folder` (sprite.jpg + meta.json). */
export async function buildThumbnail(
    path: string,
    format: "db" | "mcap",
    inspection: Inspection,
    folder: string,
    pause = PAUSE_BETWEEN_FRAMES_MS,
): Promise<ThumbMeta | null> {
    const started = performance.now()
    const cpuBefore = process.cpuUsage()
    const source = format === "db" ? dbSource(path, inspection) : await mcapSource(path, inspection)
    let ffmpegRuns = 0
    try {
        const main = pickMainCamera(await source.candidates())
        if (!main) {
            return null
        }
        const stream = inspection.streams.find((s) => s.name === main.name)!
        const times = frameTimes(stream.start ?? 0, stream.end ?? 0)
        const work = `${folder}.partial`
        await Deno.remove(work, { recursive: true }).catch(() => {})
        Deno.mkdirSync(work, { recursive: true })
        let written = 0
        for (const time of times) {
            const image = await source.frameAt(main.name, time)
            if (image) {
                await writeFrame(image, join(work, `${String(written).padStart(2, "0")}.jpg`))
                ffmpegRuns++
                written++
            }
            await sleep(pause)
        }
        if (!written) {
            return null
        }
        // the frames side by side: one request per row, and the page scrubs by background-position
        await run([
            "-hide_banner",
            "-loglevel",
            "error",
            "-start_number",
            "0",
            "-i",
            join(work, "%02d.jpg"),
            "-vf",
            `tile=${written}x1`,
            "-frames:v",
            "1",
            "-q:v",
            "6",
            "-y",
            join(work, "sprite.jpg"),
        ], new Uint8Array())
        ffmpegRuns++
        const first = compressedSize(await Deno.readFile(join(work, "00.jpg")))
        for (let i = 0; i < written; i++) {
            await Deno.remove(join(work, `${String(i).padStart(2, "0")}.jpg`))
        }
        const cpu = process.cpuUsage(cpuBefore)
        const meta: ThumbMeta = {
            frames: written,
            width: first.width,
            height: first.height,
            stream: main.name,
            encoding: main.encoding,
            source: { width: main.width, height: main.height },
            times,
            stats: {
                wallSeconds: (performance.now() - started) / 1000,
                appCpuSeconds: (cpu.user + cpu.system) / 1e6,
                ffmpegRuns,
            },
        }
        await Deno.writeTextFile(join(work, "meta.json"), JSON.stringify(meta))
        await Deno.remove(folder, { recursive: true }).catch(() => {})
        Deno.renameSync(work, folder)
        return meta
    } finally {
        source.close()
    }
}

export { PAUSE_BETWEEN_RECORDINGS_MS }

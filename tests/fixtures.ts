// Tiny real recordings for tests: a memory2 .db (the _streams table, a stream table with ts, its _blob table) and an
// .mcap (CDR or raw-LCM channels), written from scratch so tests need no data download.
import { DatabaseSync } from "node:sqlite"
import { McapWriter } from "../backend/deps.ts"

export async function tempDir() {
    return await Deno.makeTempDir({ prefix: "dim_recordings_test_" })
}

/** LCM tf2_msgs/TFMessage with one transform parent → child (frame names are all the tree reader looks at). */
export function lcmTf(parent: string, child: string): Uint8Array {
    const enc = new TextEncoder()
    const parts: number[] = []
    const int32 = (n: number) => parts.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255)
    const str = (s: string) => {
        const bytes = enc.encode(s)
        int32(bytes.length + 1)
        parts.push(...bytes, 0)
    }
    parts.push(...new Array(8).fill(1)) // fingerprint
    int32(1) // transforms_length
    int32(0) // seq
    int32(0) // sec
    int32(0) // nsec
    str(parent)
    str(child)
    parts.push(...new Array(7 * 8).fill(0))
    return new Uint8Array(parts)
}

/** LCM sensor_msgs/Image, mono8 (dimos_lcm declares data_length first). */
export function lcmImage(width: number, height: number, encoding = "mono8", fill = 128): Uint8Array {
    const enc = new TextEncoder()
    const parts: number[] = []
    const int32 = (n: number) => parts.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255)
    const str = (s: string) => {
        const bytes = enc.encode(s)
        int32(bytes.length + 1)
        parts.push(...bytes, 0)
    }
    const channels = encoding === "rgb8" ? 3 : 1
    const length = width * height * channels
    parts.push(...new Array(8).fill(2))
    int32(length)
    int32(0)
    int32(0)
    int32(0)
    str("camera")
    int32(height)
    int32(width)
    str(encoding)
    parts.push(0)
    int32(width * channels)
    const out = new Uint8Array(parts.length + length)
    out.set(parts)
    out.fill(fill, parts.length)
    return out
}

export type StreamSpec = {
    name: string
    payload: string
    codec?: string
    times: number[]
    blob?: (i: number) => Uint8Array
}

export function writeDb(path: string, streams: StreamSpec[]) {
    const db = new DatabaseSync(path)
    db.exec("CREATE TABLE _streams (name TEXT PRIMARY KEY, config TEXT NOT NULL)")
    for (const stream of streams) {
        db.prepare("INSERT INTO _streams VALUES (?, ?)").run(
            stream.name,
            JSON.stringify({ payload_module: stream.payload, codec_id: stream.codec ?? "lcm" }),
        )
        db.exec(`CREATE TABLE "${stream.name}" (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL UNIQUE)`)
        db.exec(`CREATE TABLE "${stream.name}_blob" (id INTEGER PRIMARY KEY, data BLOB NOT NULL)`)
        stream.times.forEach((ts, i) => {
            const { lastInsertRowid } = db.prepare(`INSERT INTO "${stream.name}" (ts) VALUES (?)`).run(ts)
            db.prepare(`INSERT INTO "${stream.name}_blob" VALUES (?, ?)`).run(
                lastInsertRowid,
                stream.blob ? stream.blob(i) : new Uint8Array([0]),
            )
        })
    }
    db.close()
}

export type ChannelSpec = {
    topic: string
    encoding: "cdr" | "lcm"
    schema?: string
    schemaText?: string
    times: number[]
    data?: (i: number) => Uint8Array
}

export async function writeMcap(path: string, channels: ChannelSpec[]) {
    const file = await Deno.open(path, { write: true, create: true, truncate: true })
    let position = 0n
    const mcap = new McapWriter({
        writable: {
            write: async (buffer: Uint8Array) => {
                await file.write(buffer)
                position += BigInt(buffer.byteLength)
            },
            position: () => position,
        },
    })
    await mcap.start({ profile: "", library: "test" })
    const messages: { channelId: number; time: number; data: Uint8Array }[] = []
    for (const spec of channels) {
        const schemaId = spec.schema
            ? await mcap.registerSchema({
                name: spec.schema,
                encoding: "ros2msg",
                data: new TextEncoder().encode(spec.schemaText ?? "uint8 x"),
            })
            : 0
        const channelId = await mcap.registerChannel({
            topic: spec.topic,
            messageEncoding: spec.encoding,
            schemaId,
            metadata: new Map(
                spec.schema ? [] : [["type", spec.topic.includes("image") ? "sensor_msgs.Image" : "x.Y"]],
            ),
        })
        spec.times.forEach((time, i) =>
            messages.push({ channelId, time, data: spec.data ? spec.data(i) : new Uint8Array([0]) })
        )
    }
    messages.sort((a, b) => a.time - b.time)
    let sequence = 0
    for (const message of messages) {
        const t = BigInt(Math.round(message.time * 1e9))
        await mcap.addMessage({
            channelId: message.channelId,
            sequence: sequence++,
            logTime: t,
            publishTime: t,
            data: message.data,
        })
    }
    await mcap.end()
    file.close()
}

export const range = (start: number, count: number, step: number) =>
    Array.from({ length: count }, (_, i) => start + i * step)

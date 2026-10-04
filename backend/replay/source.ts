// A recording opened for playback, read lazily: opening reads only the stream list and, per stream when first asked,
// its message times (a .db's `ts` column; an .mcap's MessageIndex records, 16 bytes a message). A message's payload is
// read when the playhead needs it: one blob from SQLite, or one chunk of the .mcap (decompressed, kept in a small LRU).
// Nothing ever reads the whole file into memory.
import { lz4, zstdDecompress } from "../deps.ts"
import { openMcap } from "../recordings/mcap.ts"
import { openDb } from "../recordings/sqlite.ts"
import { formatOf, shortType } from "../recordings/inspect.ts"
import type { DatabaseSync } from "node:sqlite"

export type Kind = "image" | "cloud" | "tf" | "pose" | "info" | "other"

export type StreamMeta = {
    name: string
    /** short type: sensor_msgs.Image, nav_msgs.Odometry, ... (the key the page subscribes to says it too) */
    type: string
    /** how payloads are stored: lcm, lz4+lcm, jpeg (a .db's codec); cdr, lcm, json (an .mcap channel's) */
    encoding: string
    kind: Kind
    count: number
    /** an .mcap channel's schema (ros2msg text for cdr) */
    schemaName?: string
    schemaText?: string
}

export type StreamIndex = {
    /** message times in seconds, ascending */
    times: Float64Array
}

export interface Source {
    readonly format: "db" | "mcap"
    readonly path: string
    readonly streams: StreamMeta[]
    /** message times of one stream (read on first use, then kept) */
    index(stream: string): Promise<StreamIndex>
    /** the stored payload of message `i` (in time order) */
    read(stream: string, i: number): Promise<Uint8Array>
    close(): void
}

export function kindOf(type: string): Kind {
    if (/(^|\.)(Image|CompressedImage)$/.test(type)) {
        return "image"
    }
    if (/PointCloud2$/.test(type)) {
        return "cloud"
    }
    if (/TFMessage$/.test(type)) {
        return "tf"
    }
    if (/(Odometry|PoseStamped|PoseWithCovarianceStamped)$/.test(type)) {
        return "pose"
    }
    if (/CameraInfo$/.test(type)) {
        return "info"
    }
    return "other"
}

/** Index of the last time <= t (-1 when every time is after t). */
export function atOrBefore(times: Float64Array, t: number): number {
    let low = 0
    let high = times.length - 1
    let found = -1
    while (low <= high) {
        const middle = (low + high) >> 1
        if (times[middle] <= t) {
            found = middle
            low = middle + 1
        } else {
            high = middle - 1
        }
    }
    return found
}

export async function openSource(path: string): Promise<Source> {
    const format = await formatOf(path)
    if (format === "db") {
        return new DbSource(path)
    }
    if (format === "mcap") {
        return await McapSource.open(path)
    }
    throw new Error(`not a .db or .mcap recording: ${path}`)
}

// ── .db (memory2 SQLite): a stream is a table (id, ts, ...) plus `<name>_blob` (id, data) ──

class DbSource implements Source {
    readonly format = "db"
    readonly streams: StreamMeta[] = []
    #db: DatabaseSync
    #indexes = new Map<string, StreamIndex & { ids: Float64Array }>()

    constructor(readonly path: string) {
        this.#db = openDb(path)
        const rows = this.#db.prepare(
            "SELECT name, config FROM _streams ORDER BY name",
        ).all() as {
            name: string
            config: string
        }[]
        for (const { name, config } of rows) {
            let payload = ""
            let codec = ""
            try {
                const parsed = JSON.parse(config)
                payload = parsed?.payload_module ?? ""
                codec = parsed?.codec_id ?? ""
            } catch {
                // not JSON: the type stays unknown
            }
            let count = 0
            try {
                count = (this.#db.prepare(`SELECT COUNT(*) AS n FROM "${quote(name)}"`)
                    .get() as { n: number }).n
            } catch {
                continue // registered without its table
            }
            const type = shortType(payload)
            this.streams.push({
                name,
                type,
                encoding: codec,
                kind: kindOf(type),
                count,
            })
        }
    }

    index(stream: string): Promise<StreamIndex> {
        let found = this.#indexes.get(stream)
        if (!found) {
            const meta = this.streams.find((s) => s.name === stream)
            if (!meta) {
                throw new Error(`no stream ${stream}`)
            }
            const times = new Float64Array(meta.count)
            const ids = new Float64Array(meta.count)
            let n = 0
            const statement = this.#db.prepare(
                `SELECT id, ts FROM "${quote(stream)}" ORDER BY ts`,
            )
            for (
                const row of statement.iterate() as Iterable<{ id: number; ts: number }>
            ) {
                if (n >= times.length) {
                    break // rows added since the count: they wait for a reopen
                }
                times[n] = row.ts
                ids[n] = row.id
                n++
            }
            found = { times: times.subarray(0, n), ids: ids.subarray(0, n) }
            this.#indexes.set(stream, found)
        }
        return Promise.resolve(found)
    }

    async read(stream: string, i: number): Promise<Uint8Array> {
        const { ids } = await this.index(stream) as StreamIndex & {
            ids: Float64Array
        }
        const row = this.#db.prepare(
            `SELECT data FROM "${quote(stream)}_blob" WHERE id = ?`,
        ).get(ids[i]) as
            | { data: Uint8Array }
            | undefined
        if (!row) {
            throw new Error(`${stream}: message ${i} has no blob in this file`)
        }
        return new Uint8Array(row.data)
    }

    #closed = false
    close() {
        if (!this.#closed) {
            this.#closed = true
            this.#db.close()
        }
    }
}

function quote(name: string) {
    return name.replaceAll('"', '""')
}

// ── .mcap: per-channel indexes from the MessageIndex records after each chunk ──

const MESSAGE_INDEX_OPCODE = 0x07
const CHUNK_CACHE_BYTES = 96 * 1024 * 1024

type McapIndex = StreamIndex & { chunks: Uint32Array; offsets: Float64Array }
type ChunkInfo = {
    start: bigint
    length: bigint
    compression: string
    indexStart: bigint
    indexLength: bigint
}

class McapSource implements Source {
    readonly format = "mcap"
    readonly streams: StreamMeta[] = []
    #indexes = new Map<number, McapIndex>()
    #channelOf = new Map<string, number>()
    #chunks: ChunkInfo[] = []
    #cache = new Map<number, Uint8Array>()
    #cacheBytes = 0
    #indexed: Promise<void> | null = null

    private constructor(
        readonly path: string,
        private mcap: Awaited<ReturnType<typeof openMcap>>,
    ) {}

    static async open(path: string): Promise<McapSource> {
        const mcap = await openMcap(path)
        const source = new McapSource(path, mcap)
        const { reader } = mcap
        if (
            reader.chunkIndexes.length === 0 &&
            (reader.statistics?.messageCount ?? 0n) > 0n
        ) {
            mcap.close()
            throw new Error(
                "this .mcap has no chunk index (an unindexed file): re-save it with dtk data to_mcap",
            )
        }
        for (
            const chunk of [...reader.chunkIndexes].sort((a, b) => Number(a.chunkStartOffset - b.chunkStartOffset))
        ) {
            const offsets = [...chunk.messageIndexOffsets.values()]
            let indexStart = offsets.length ? offsets[0] : 0n
            for (const offset of offsets) {
                indexStart = offset < indexStart ? offset : indexStart
            }
            source.#chunks.push({
                start: chunk.chunkStartOffset,
                length: chunk.chunkLength,
                compression: chunk.compression,
                indexStart,
                indexLength: chunk.messageIndexLength,
            })
        }
        for (
            const channel of [...reader.channelsById.values()].sort((a, b) => a.topic.localeCompare(b.topic))
        ) {
            const schema = reader.schemasById.get(channel.schemaId)
            const typeName = schema?.name ?? channel.metadata.get("type") ??
                channel.metadata.get("lcm_type") ?? ""
            const type = shortType(typeName)
            const name = channel.topic.replace(/^\//, "")
            source.#channelOf.set(name, channel.id)
            source.streams.push({
                name,
                type,
                encoding: channel.messageEncoding,
                kind: kindOf(type),
                count: Number(
                    reader.statistics?.channelMessageCounts.get(channel.id) ?? 0n,
                ),
                schemaName: schema?.name,
                schemaText: schema ? new TextDecoder().decode(schema.data) : undefined,
            })
        }
        return source
    }

    /** One pass over every chunk's MessageIndex block (a few MB even for a big file) builds every channel's index. */
    #buildIndexes(): Promise<void> {
        this.#indexed ??= (async () => {
            const lists = new Map<
                number,
                { times: number[]; chunks: number[]; offsets: number[] }
            >()
            for (let c = 0; c < this.#chunks.length; c++) {
                const chunk = this.#chunks[c]
                if (chunk.indexLength === 0n) {
                    continue
                }
                const block = await this.mcap.read(chunk.indexStart, chunk.indexLength)
                const view = new DataView(
                    block.buffer,
                    block.byteOffset,
                    block.byteLength,
                )
                let pos = 0
                while (pos + 9 <= block.byteLength) {
                    const opcode = view.getUint8(pos)
                    const recordLength = Number(view.getBigUint64(pos + 1, true))
                    pos += 9
                    if (opcode === MESSAGE_INDEX_OPCODE) {
                        const channelId = view.getUint16(pos, true)
                        const entriesEnd = pos + 6 + view.getUint32(pos + 2, true)
                        let list = lists.get(channelId)
                        if (!list) {
                            list = { times: [], chunks: [], offsets: [] }
                            lists.set(channelId, list)
                        }
                        for (let entry = pos + 6; entry + 16 <= entriesEnd; entry += 16) {
                            list.times.push(Number(view.getBigUint64(entry, true)) / 1e9)
                            list.chunks.push(c)
                            list.offsets.push(Number(view.getBigUint64(entry + 8, true)))
                        }
                    }
                    pos += recordLength
                }
            }
            for (const [channelId, list] of lists) {
                const order = list.times.map((_, i) => i).sort((a, b) => list.times[a] - list.times[b])
                this.#indexes.set(channelId, {
                    times: Float64Array.from(order, (i) => list.times[i]),
                    chunks: Uint32Array.from(order, (i) => list.chunks[i]),
                    offsets: Float64Array.from(order, (i) => list.offsets[i]),
                })
            }
        })()
        return this.#indexed
    }

    async index(stream: string): Promise<StreamIndex> {
        const channelId = this.#channelOf.get(stream)
        if (channelId === undefined) {
            throw new Error(`no stream ${stream}`)
        }
        await this.#buildIndexes()
        return this.#indexes.get(channelId) ?? { times: new Float64Array(0) }
    }

    /** a chunk's records, decompressed (an LRU keeps the last ~96 MB) */
    async #chunk(c: number): Promise<Uint8Array> {
        const cached = this.#cache.get(c)
        if (cached) {
            this.#cache.delete(c)
            this.#cache.set(c, cached)
            return cached
        }
        const chunk = this.#chunks[c]
        const record = await this.mcap.read(chunk.start, chunk.length)
        const view = new DataView(
            record.buffer,
            record.byteOffset,
            record.byteLength,
        )
        // opcode u8, length u64, start u64, end u64, uncompressed size u64, crc u32, compression string, records u64 + bytes
        let at = 1 + 8 + 8 + 8
        const uncompressedSize = Number(view.getBigUint64(at, true))
        at += 8 + 4
        const compressionLength = view.getUint32(at, true)
        at += 4 + compressionLength
        const recordsLength = Number(view.getBigUint64(at, true))
        at += 8
        const body = record.subarray(at, at + recordsLength)
        let records: Uint8Array
        if (chunk.compression === "") {
            records = body
        } else if (chunk.compression === "zstd") {
            records = zstdDecompress(body, new Uint8Array(uncompressedSize))
        } else if (chunk.compression === "lz4") {
            records = new Uint8Array(lz4.decompress(body))
        } else {
            throw new Error(`unsupported chunk compression ${chunk.compression}`)
        }
        this.#cache.set(c, records)
        this.#cacheBytes += records.byteLength
        for (const [key, value] of this.#cache) {
            if (this.#cacheBytes <= CHUNK_CACHE_BYTES || this.#cache.size <= 1) {
                break
            }
            this.#cache.delete(key)
            this.#cacheBytes -= value.byteLength
        }
        return records
    }

    async read(stream: string, i: number): Promise<Uint8Array> {
        const index = await this.index(stream) as McapIndex
        const records = await this.#chunk(index.chunks[i])
        const offset = index.offsets[i]
        const view = new DataView(
            records.buffer,
            records.byteOffset,
            records.byteLength,
        )
        // Message: opcode u8, length u64, channel u16, sequence u32, log time u64, publish time u64, data
        const length = Number(view.getBigUint64(offset + 1, true))
        const dataStart = offset + 9 + 2 + 4 + 8 + 8
        return records.subarray(dataStart, offset + 9 + length)
    }

    #closed = false
    close() {
        if (!this.#closed) {
            this.#closed = true
            this.#cache.clear()
            this.mcap.close()
        }
    }
}

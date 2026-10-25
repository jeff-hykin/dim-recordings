// A recording opened for playback, read lazily: opening reads only the stream list and, per stream when first asked,
// its message times (a .db's `ts` column; an .mcap's MessageIndex records, 16 bytes a message). A message's payload is
// read when the playhead needs it: one blob from SQLite, or one chunk of the .mcap (decompressed, kept in a small LRU).
// Nothing ever reads the whole file into memory, and the indexes of all its streams together hold at most
// INDEX_BUDGET messages: a stream too big for its share keeps every `stride`-th message (playback and scrubbing see
// that many fewer; its count stays the true one).
import { lz4, zstdDecompress } from "../deps.ts"
import { openMcap } from "../recordings/mcap.ts"
import { shares } from "../recordings/budget.ts"
import { idRange, openDb, pagesOfIds, quoteName } from "../recordings/sqlite.ts"
import { channelType, formatOf, shortType } from "../recordings/inspect.ts"
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
    /** how many of the stream's messages each entry stands for (1: all of them; more for a stream past its share) */
    stride: number
}

/** most index entries one open recording keeps over all its streams (16-20 bytes each) */
export const INDEX_BUDGET = 3_000_000

/** one in how many of each count an index keeps, so all of them fit in INDEX_BUDGET */
function stridesOf(counts: number[]): number[] {
    const keeps = shares(counts, INDEX_BUDGET)
    return counts.map((count, i) => count <= keeps[i] ? 1 : Math.ceil(count / Math.max(1, keeps[i])))
}

/** lets the server answer others between pages of an index read (a yield, no wait) */
const yieldThread = () => new Promise((resolve) => setTimeout(resolve, 0))

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
        return new DbSource(path, await openDb(path))
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
    #indexes = new Map<string, Promise<StreamIndex & { ids: Float64Array }>>()
    #ranges = new Map<string, { low: number; high: number } | null>()
    #strides = new Map<string, number>()

    constructor(readonly path: string, db: DatabaseSync) {
        this.#db = db
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
                // from the id range (two rowid lookups), not COUNT(*): that walks every row on the server's thread
                const range = idRange(this.#db, name)
                this.#ranges.set(name, range)
                count = range ? range.high - range.low + 1 : 0
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
        const strides = stridesOf(this.streams.map((s) => s.count))
        this.streams.forEach((s, i) => this.#strides.set(s.name, strides[i]))
    }

    index(stream: string): Promise<StreamIndex & { ids: Float64Array }> {
        let found = this.#indexes.get(stream)
        if (!found) {
            const meta = this.streams.find((s) => s.name === stream)
            if (!meta) {
                return Promise.reject(new Error(`no stream ${stream}`))
            }
            found = this.#readIndex(stream, this.#ranges.get(stream) ?? null, this.#strides.get(stream) ?? 1)
            this.#indexes.set(stream, found)
        }
        return found
    }

    /** By id, a page at a time with the thread handed back between pages (ts has no index: ORDER BY ts would sort
     * the whole table in one call), sorted by time after when arrival order wasn't time order. */
    async #readIndex(
        stream: string,
        range: { low: number; high: number } | null,
        stride: number,
    ): Promise<StreamIndex & { ids: Float64Array }> {
        if (!range) {
            return { times: new Float64Array(0), ids: new Float64Array(0), stride }
        }
        const size = Math.ceil((range.high - range.low + 1) / stride)
        const times = new Float64Array(size)
        const ids = new Float64Array(size)
        let n = 0
        let ordered = true
        const pages = pagesOfIds<{ id: number; ts: number }>(this.#db, "ts", quoteName(stream), [
            range.low,
            range.high + 1,
        ], { every: stride })
        for (const rows of pages) {
            for (const row of rows) {
                if (n >= size) {
                    break
                }
                times[n] = row.ts
                ids[n] = row.id
                ordered &&= n === 0 || row.ts >= times[n - 1]
                n++
            }
            await yieldThread()
            if (this.#closed) {
                break // what's read so far: a closed source answers nothing more anyway
            }
        }
        if (ordered) {
            return { times: times.subarray(0, n), ids: ids.subarray(0, n), stride }
        }
        const order = new Uint32Array(n).map((_, i) => i).sort((a, b) => times[a] - times[b] || a - b)
        return {
            times: Float64Array.from(order, (i) => times[i]),
            ids: Float64Array.from(order, (i) => ids[i]),
            stride,
        }
    }

    async read(stream: string, i: number): Promise<Uint8Array> {
        const { ids } = await this.index(stream)
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
            const typeName = channelType(schema, channel.metadata)
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

    /** Every chunk's MessageIndex records (16 bytes a message; one read a chunk) give every channel's index in one
     * pass, each kept to its share of INDEX_BUDGET: every `stride`-th entry, straight into typed arrays. */
    #buildIndexes(): Promise<void> {
        this.#indexed ??= (async () => {
            const ids = [...this.#channelOf.values()]
            let counts = ids.map((id) => this.streams.find((s) => this.#channelOf.get(s.name) === id)?.count ?? 0)
            if (!this.mcap.reader.statistics) {
                // no statistics: a counting pass first (entries are counted by their records' lengths, not read)
                const counted = new Map<number, number>()
                await this.#eachIndexRecord((channelId, _c, _view, _entries, length) => {
                    counted.set(channelId, (counted.get(channelId) ?? 0) + Math.floor(length / 16))
                })
                counts = ids.map((id) => counted.get(id) ?? 0)
            }
            const strides = stridesOf(counts)
            type Building = { times: Float64Array; chunks: Uint32Array; offsets: Float64Array; n: number; seen: number }
            const building = new Map<number, Building & { stride: number }>()
            for (const [i, id] of ids.entries()) {
                const size = Math.ceil(counts[i] / strides[i]) + 1
                building.set(id, {
                    times: new Float64Array(size),
                    chunks: new Uint32Array(size),
                    offsets: new Float64Array(size),
                    n: 0,
                    seen: 0,
                    stride: strides[i],
                })
            }
            await this.#eachIndexRecord((channelId, c, view, entries, length) => {
                const list = building.get(channelId)
                if (!list) {
                    return
                }
                for (let entry = entries; entry + 16 <= entries + length; entry += 16) {
                    if (list.seen++ % list.stride !== 0 || list.n >= list.times.length) {
                        continue
                    }
                    list.times[list.n] = Number(view.getBigUint64(entry, true)) / 1e9
                    list.chunks[list.n] = c
                    list.offsets[list.n] = Number(view.getBigUint64(entry + 8, true))
                    list.n++
                }
            })
            for (const [channelId, list] of building) {
                const n = list.n
                const times = list.times.subarray(0, n)
                let ordered = true
                for (let i = 1; i < n && ordered; i++) {
                    ordered = times[i] >= times[i - 1]
                }
                if (ordered) {
                    this.#indexes.set(channelId, {
                        times,
                        chunks: list.chunks.subarray(0, n),
                        offsets: list.offsets.subarray(0, n),
                        stride: list.stride,
                    })
                    continue
                }
                const order = new Uint32Array(n).map((_, i) => i).sort((a, b) => times[a] - times[b] || a - b)
                this.#indexes.set(channelId, {
                    times: Float64Array.from(order, (i) => times[i]),
                    chunks: Uint32Array.from(order, (i) => list.chunks[i]),
                    offsets: Float64Array.from(order, (i) => list.offsets[i]),
                    stride: list.stride,
                })
            }
        })()
        return this.#indexed
    }

    /** Calls `each` with every MessageIndex record (its channel, chunk, a view, where its entries start and their
     * length), a chunk's block at a time, handing the thread back between chunks. */
    async #eachIndexRecord(
        each: (channelId: number, chunk: number, view: DataView, entries: number, length: number) => void,
    ) {
        for (let c = 0; c < this.#chunks.length; c++) {
            const chunk = this.#chunks[c]
            if (chunk.indexLength === 0n) {
                continue
            }
            const block = await this.mcap.read(chunk.indexStart, chunk.indexLength)
            const view = new DataView(block.buffer, block.byteOffset, block.byteLength)
            let pos = 0
            while (pos + 9 <= block.byteLength) {
                const opcode = view.getUint8(pos)
                const recordLength = Number(view.getBigUint64(pos + 1, true))
                pos += 9
                if (opcode === MESSAGE_INDEX_OPCODE) {
                    const length = Math.min(view.getUint32(pos + 2, true), block.byteLength - pos - 6)
                    each(view.getUint16(pos, true), c, view, pos + 6, length)
                }
                pos += recordLength
            }
            if (this.#closed) {
                return // closed: the rest isn't wanted
            }
        }
    }

    async index(stream: string): Promise<StreamIndex> {
        const channelId = this.#channelOf.get(stream)
        if (channelId === undefined) {
            throw new Error(`no stream ${stream}`)
        }
        await this.#buildIndexes()
        return this.#indexes.get(channelId) ?? { times: new Float64Array(0), stride: 1 }
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

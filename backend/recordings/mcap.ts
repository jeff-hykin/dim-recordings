// Opening an .mcap for indexed reads (summary section, per-topic time ranges), the same way dtk's tools do.
import { lz4, McapIndexedReader, zstdDecompress } from "../deps.ts"
import { shares, sortRuns, windowsOf } from "./budget.ts"
import { reachable } from "./slow_fs.ts"

export type McapFile = {
    reader: McapIndexedReader
    close: () => void
    size: number
    read: (offset: bigint, length: bigint) => Promise<Uint8Array>
}

export async function openMcap(path: string): Promise<McapFile> {
    await reachable(path)
    const file = await Deno.open(path, { read: true })
    const size = (await file.stat()).size
    // the reader asks for several ranges at once; one seek+read at a time keeps them from interleaving
    let queue: Promise<unknown> = Promise.resolve()
    const read = (offset: bigint, length: bigint): Promise<Uint8Array> => {
        const job = queue.then(async () => {
            const buffer = new Uint8Array(Number(length))
            await file.seek(Number(offset), Deno.SeekMode.Start)
            let filled = 0
            while (filled < buffer.length) {
                const got = await file.read(buffer.subarray(filled))
                if (got === null) {
                    break
                }
                filled += got
            }
            return buffer
        })
        queue = job.catch(() => {})
        return job
    }
    try {
        const reader = await McapIndexedReader.Initialize({
            readable: { size: () => Promise.resolve(BigInt(size)), read },
            decompressHandlers: {
                zstd: (bytes: Uint8Array, decompressedSize: bigint) =>
                    zstdDecompress(bytes, new Uint8Array(Number(decompressedSize))),
                lz4: (bytes: Uint8Array) => new Uint8Array(lz4.decompress(bytes)),
            },
        })
        return { reader, size, read, close: () => file.close() }
    } catch (error) {
        file.close()
        throw error
    }
}

const MESSAGE_INDEX_OPCODE = 0x07

/**
 * Each channel's message log times from the MessageIndex records after each chunk (16 bytes a message), at most
 * `budget` times over all channels: a channel too big for its share keeps windows of consecutive chunks across it,
 * with NaN between them. Only the chunks some channel keeps are read. null when the file has no indexes.
 * (dtk tools/db_summary.js)
 */
export async function logTimesFromIndexes(
    mcap: McapFile,
    budget: number,
): Promise<Map<number, { times: Float64Array; count: number; whole: boolean }> | null> {
    const { reader } = mcap
    const chunks = [...reader.chunkIndexes].sort((a, b) =>
        Number(a.messageStartTime - b.messageStartTime) || Number(a.chunkStartOffset - b.chunkStartOffset)
    )
    if (chunks.length === 0) {
        return null
    }
    const ids = [...reader.channelsById.keys()]
    // per channel, the chunks it's in, in time order
    const chunksOf = new Map<number, number[]>(ids.map((id) => [id, []]))
    for (const [c, chunk] of chunks.entries()) {
        for (const id of chunk.messageIndexOffsets.keys()) {
            chunksOf.get(id)?.push(c)
        }
    }
    const counts = ids.map((id) => {
        const counted = reader.statistics?.channelMessageCounts.get(id)
        // no statistics: assume it's big, so it's read in windows (a channel in few chunks is read whole anyway)
        return counted !== undefined ? Number(counted) : Number.MAX_SAFE_INTEGER
    })
    const keeps = shares(counts, budget)
    type Want = { times: Float64Array; n: number; last: number; whole: boolean }
    const wants = new Map<number, Want>()
    /** chunk → the channels that want its index entries */
    const byChunk = new Map<number, number[]>()
    for (const [k, id] of ids.entries()) {
        const list = chunksOf.get(id)!
        const whole = counts[k] <= keeps[k]
        let picked = list
        if (!whole && list.length) {
            // the share of its chunks that holds about its share of messages, in windows of consecutive chunks
            const chunkShare = Math.max(1, Math.floor(list.length * keeps[k] / counts[k]))
            picked = windowsOf(list.length, chunkShare).flatMap(([first, length]) => list.slice(first, first + length))
        }
        wants.set(id, { times: new Float64Array(Math.max(0, keeps[k]) + 16), n: 0, last: -2, whole })
        for (const c of picked) {
            byChunk.set(c, [...(byChunk.get(c) ?? []), id])
        }
    }
    const cursor = new Map<number, number>(ids.map((id) => [id, 0]))
    for (const c of [...byChunk.keys()].sort((a, b) => a - b)) {
        const chunk = chunks[c]
        const wanted = new Set(byChunk.get(c)!.filter((id) => wants.get(id)!.n < wants.get(id)!.times.length))
        const offsets = [...chunk.messageIndexOffsets.values()]
        if (!wanted.size || !offsets.length || chunk.messageIndexLength === 0n) {
            continue
        }
        let start = offsets[0]
        for (const offset of offsets) {
            start = offset < start ? offset : start
        }
        // the chunk's MessageIndex records, one read: 16 bytes a message, a few hundred KB at most
        const block = await mcap.read(start, chunk.messageIndexLength)
        const view = new DataView(block.buffer, block.byteOffset, block.byteLength)
        let pos = 0
        while (pos + 9 <= block.byteLength) {
            const opcode = view.getUint8(pos)
            const recordLength = Number(view.getBigUint64(pos + 1, true))
            pos += 9
            const id = opcode === MESSAGE_INDEX_OPCODE ? view.getUint16(pos, true) : -1
            if (wanted.has(id)) {
                const want = wants.get(id)!
                // its place among the chunks it's in: a skipped one means a window ended, and no gap spans it
                const list = chunksOf.get(id)!
                let at = cursor.get(id)!
                while (at < list.length && list[at] < c) {
                    at++
                }
                cursor.set(id, at)
                if (want.n > 0 && at !== want.last + 1) {
                    want.times[want.n++] = NaN
                }
                want.last = at
                const entriesEnd = pos + 6 + view.getUint32(pos + 2, true)
                for (let entry = pos + 6; entry + 16 <= entriesEnd && want.n < want.times.length; entry += 16) {
                    want.times[want.n++] = Number(view.getBigUint64(entry, true)) / 1e9
                }
            }
            pos += recordLength
        }
    }
    const out = new Map<number, { times: Float64Array; count: number; whole: boolean }>()
    for (const [k, id] of ids.entries()) {
        const want = wants.get(id)!
        let times = want.times.subarray(0, want.n)
        while (times.length && Number.isNaN(times[times.length - 1])) {
            times = times.subarray(0, times.length - 1)
        }
        const whole = want.whole && !times.some(Number.isNaN)
        const counted = counts[k] === Number.MAX_SAFE_INTEGER ? times.length : counts[k]
        out.set(id, { times: sortRuns(times), count: counted, whole })
    }
    return out
}

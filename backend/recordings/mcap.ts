// Opening an .mcap for indexed reads (summary section, per-topic time ranges), the same way dtk's tools do.
import { lz4, McapIndexedReader, zstdDecompress } from "../deps.ts"
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
 * Every message's log time per channel, from the MessageIndex records after each chunk (16 bytes a message), so a
 * big file's gaps and rates cost a few MB of reads, not a decompressing pass. null when the file has no indexes.
 * (dtk tools/db_summary.js)
 */
export async function logTimesFromIndexes(mcap: McapFile): Promise<Map<number, number[]> | null> {
    const chunks = mcap.reader.chunkIndexes
    if (chunks.length === 0) {
        return null
    }
    const timesById = new Map<number, number[]>()
    for (const chunk of chunks) {
        const offsets = [...chunk.messageIndexOffsets.values()]
        if (offsets.length === 0 || chunk.messageIndexLength === 0n) {
            continue
        }
        let start = offsets[0]
        for (const offset of offsets) {
            if (offset < start) {
                start = offset
            }
        }
        const block = await mcap.read(start, chunk.messageIndexLength)
        const view = new DataView(block.buffer, block.byteOffset, block.byteLength)
        let pos = 0
        while (pos + 9 <= block.byteLength) {
            const opcode = view.getUint8(pos)
            const recordLength = Number(view.getBigUint64(pos + 1, true))
            pos += 9
            if (opcode === MESSAGE_INDEX_OPCODE) {
                const channelId = view.getUint16(pos, true)
                const entriesEnd = pos + 6 + view.getUint32(pos + 2, true)
                let times = timesById.get(channelId)
                if (!times) {
                    times = []
                    timesById.set(channelId, times)
                }
                for (let entry = pos + 6; entry + 16 <= entriesEnd; entry += 16) {
                    times.push(Number(view.getBigUint64(entry, true)) / 1e9)
                }
            }
            pos += recordLength
        }
    }
    return timesById
}

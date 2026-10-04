// Rename, delete or duplicate one topic of an .mcap, as an in-place edit of the file: the edited file is streamed
// into a temporary file beside it (`.<name>.editing`) and renamed over the original, so the path never holds a half-
// written file and no copy is left behind. Same plan as dtk's mcap_edit.py (tools/mcap_edit.py): only the chunks that
// change are decompressed and rewritten; every other chunk and its MessageIndex records are copied byte for byte, so
// an edit costs one sequential read + write of the file, never the file in memory.
//
// - rename: the chunk(s) holding the topic's Channel record (before its first message) and the summary's Channel
//   record get the new name; message chunks stay as they are (messages name their channel by id).
// - delete: the topic's messages and Channel record leave every chunk they're in (rewritten, lz4); its summary
//   records and statistics go.
// - duplicate: the topic's messages are appended as new chunks (lz4) under a new channel with the new name and the
//   same schema.
import { basename, dirname, join } from "node:path"
import { lz4, McapIndexedReader, McapRecordBuilder, zstdDecompress } from "../deps.ts"
import { openMcap } from "../recordings/mcap.ts"

type ChunkIndex = Omit<McapIndexedReader["chunkIndexes"][number], "type">
type AttachmentIndex = Omit<
    McapIndexedReader["attachmentIndexes"][number],
    "type"
>
type MetadataIndex = Omit<McapIndexedReader["metadataIndexes"][number], "type">
type Channel = {
    id: number
    schemaId: number
    topic: string
    messageEncoding: string
    metadata: Map<string, string>
}

export type McapEdit =
    | { op: "rename"; topic: string; to: string }
    | { op: "delete"; topic: string }
    | { op: "duplicate"; topic: string; to: string }

const OP = {
    HEADER: 0x01,
    FOOTER: 0x02,
    SCHEMA: 0x03,
    CHANNEL: 0x04,
    MESSAGE: 0x05,
    CHUNK: 0x06,
    MESSAGE_INDEX: 0x07,
    CHUNK_INDEX: 0x08,
    ATTACHMENT: 0x09,
    ATTACHMENT_INDEX: 0x0a,
    STATISTICS: 0x0b,
    METADATA: 0x0c,
    METADATA_INDEX: 0x0d,
    SUMMARY_OFFSET: 0x0e,
    DATA_END: 0x0f,
}
const MAGIC = new Uint8Array([0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a])
const CHUNK_TARGET = 4 * 1024 * 1024

/** topic names in this app have no leading slash; an .mcap's may */
const bare = (topic: string) => topic.replace(/^\//, "")

export async function editMcap(
    path: string,
    edit: McapEdit,
): Promise<{ messages: number; chunksRewritten: number }> {
    const mcap = await openMcap(path)
    const { reader } = mcap
    const channels = [...reader.channelsById.values()] as Channel[]
    const target = channels.find((channel) => bare(channel.topic) === bare(edit.topic))
    if (!target) {
        mcap.close()
        throw new Error(`no topic ${edit.topic}`)
    }
    if (edit.op !== "delete") {
        const wanted = bare(edit.to)
        if (!/^[A-Za-z0-9_][A-Za-z0-9_/.-]*$/.test(wanted)) {
            mcap.close()
            throw new Error(
                `"${edit.to}" isn't a usable topic name (letters, digits, _ / . -)`,
            )
        }
        if (channels.some((channel) => bare(channel.topic) === wanted)) {
            mcap.close()
            throw new Error(`there is already a topic named ${edit.to}`)
        }
    }
    // the edited file is written beside the original before it replaces it: there must be room for both
    const free = await freeBytes(dirname(path))
    if (free !== null && free < mcap.size + 256 * 1024 * 1024) {
        mcap.close()
        throw new Error(
            `not enough free disk to edit ${basename(path)} in place: it needs ${(mcap.size / 1e9).toFixed(2)} GB ` +
                `beside it for a moment, ${(free / 1e9).toFixed(2)} GB is free`,
        )
    }
    // the new name keeps the old one's leading slash, if it had one
    const newTopic = edit.op === "delete" ? "" : (target.topic.startsWith("/") ? "/" : "") + bare(edit.to)
    const temporary = join(dirname(path), `.${basename(path)}.editing`)
    const out = await Deno.open(temporary, {
        write: true,
        create: true,
        truncate: true,
    })
    let position = 0n
    const write = async (bytes: Uint8Array) => {
        let done = 0
        while (done < bytes.length) {
            done += await out.write(bytes.subarray(done))
        }
        position += BigInt(bytes.length)
    }
    const builder = new McapRecordBuilder({ padRecords: false })
    const emit = async (fill: (b: McapRecordBuilder) => void) => {
        builder.reset()
        fill(builder)
        await write(builder.buffer.slice())
    }
    try {
        const chunkByOffset = new Map<bigint, ChunkIndex>(
            reader.chunkIndexes.map((chunk) => [chunk.chunkStartOffset, chunk]),
        )
        const firstWithTarget = [...reader.chunkIndexes]
            .filter((chunk) => chunk.messageIndexOffsets.has(target.id))
            .reduce<bigint | null>(
                (first, chunk) => first === null || chunk.chunkStartOffset < first ? chunk.chunkStartOffset : first,
                null,
            )
        const newChunkIndexes: ChunkIndex[] = []
        const newAttachmentIndexes: AttachmentIndex[] = []
        const newMetadataIndexes: MetadataIndex[] = []
        let chunksRewritten = 0
        let removed = 0n

        await write(MAGIC)
        const summaryStart = reader.footer.summaryStart ||
            BigInt(mcap.size) - 8n - 29n
        let at = 8n
        // the chunk being copied raw: its MessageIndex records follow it and shift by the same amount
        let rawShift: bigint | null = null
        let rewrittenIndex: Uint8Array | null = null
        while (at < summaryStart) {
            const head = await mcap.read(at, 9n)
            const opcode = head[0]
            const length = new DataView(head.buffer, head.byteOffset).getBigUint64(
                1,
                true,
            )
            const recordLength = 9n + length
            if (opcode === OP.DATA_END) {
                break
            }
            if (opcode === OP.MESSAGE_INDEX) {
                if (rawShift !== null) {
                    await write(await mcap.read(at, recordLength))
                } else if (rewrittenIndex) {
                    await write(rewrittenIndex)
                    rewrittenIndex = null
                }
                at += recordLength
                continue
            }
            rawShift = null
            if (rewrittenIndex) {
                await write(rewrittenIndex) // a rewritten chunk whose original had no MessageIndex records
                rewrittenIndex = null
            }
            if (opcode === OP.CHUNK) {
                const index = chunkByOffset.get(at)
                const holdsTarget = !!index?.messageIndexOffsets.has(target.id)
                // a rename looks for the Channel record in the chunks up to the first one with the topic's messages
                const mayHoldChannel = edit.op !== "duplicate" &&
                    (firstWithTarget === null || at <= firstWithTarget)
                const rewrite = edit.op === "delete"
                    ? holdsTarget || mayHoldChannel
                    : edit.op === "rename" && mayHoldChannel
                const record = await mcap.read(at, recordLength)
                if (!rewrite || !index) {
                    const start = position
                    await write(record)
                    if (index) {
                        rawShift = start - at
                        newChunkIndexes.push({
                            ...index,
                            chunkStartOffset: start,
                            messageIndexOffsets: new Map(
                                [...index.messageIndexOffsets].map((
                                    [channel, offset],
                                ) => [channel, offset + rawShift!]),
                            ),
                        })
                    }
                } else {
                    const records = chunkRecords(record)
                    const edited = editRecords(
                        records,
                        target.id,
                        edit.op === "delete" ? null : newTopic,
                        edit.op === "delete",
                    )
                    removed += edited.removed
                    if (!edited.changed) {
                        // nothing of the topic in it after all: copy as is
                        const start = position
                        await write(record)
                        rawShift = start - at
                        newChunkIndexes.push({
                            ...index,
                            chunkStartOffset: start,
                            messageIndexOffsets: new Map(
                                [...index.messageIndexOffsets].map((
                                    [channel, offset],
                                ) => [channel, offset + rawShift!]),
                            ),
                        })
                    } else if (edited.records.length > 0) {
                        chunksRewritten++
                        const written = await writeChunk(
                            emit,
                            () => position,
                            edited.records,
                            edited.entries,
                            edited.start ?? index.messageStartTime,
                            edited.end ?? index.messageEndTime,
                        )
                        newChunkIndexes.push(written)
                        rewrittenIndex = new Uint8Array(0)
                    } else {
                        chunksRewritten++ // emptied: dropped, with its MessageIndex records
                        rewrittenIndex = new Uint8Array(0)
                    }
                }
                at += recordLength
                continue
            }
            if (opcode === OP.CHANNEL) {
                const record = await mcap.read(at, recordLength)
                const channel = parseChannel(record.subarray(9))
                if (channel.id === target.id) {
                    if (edit.op === "rename") {
                        await emit((b) => b.writeChannel({ ...channel, topic: newTopic }))
                    } else if (edit.op === "duplicate") {
                        await write(record)
                    } // delete: dropped
                } else {
                    await write(record)
                }
                at += recordLength
                continue
            }
            if (opcode === OP.MESSAGE && edit.op === "delete") {
                const record = await mcap.read(at, 11n)
                if (
                    new DataView(record.buffer, record.byteOffset).getUint16(9, true) ===
                        target.id
                ) {
                    removed++
                    at += recordLength
                    continue
                }
            }
            const start = position
            const record = await mcap.read(at, recordLength)
            await write(record)
            if (opcode === OP.ATTACHMENT) {
                const old = reader.attachmentIndexes.find((index) => index.offset === at)
                if (old) {
                    newAttachmentIndexes.push({ ...old, offset: start })
                }
            } else if (opcode === OP.METADATA) {
                const old = reader.metadataIndexes.find((index) => index.offset === at)
                if (old) {
                    newMetadataIndexes.push({ ...old, offset: start })
                }
            }
            at += recordLength
        }
        if (rewrittenIndex) {
            await write(rewrittenIndex)
        }

        // a duplicate: the topic's messages again, in new chunks, under a new channel
        let copied = 0n
        let newChannelId = -1
        if (edit.op === "duplicate") {
            newChannelId = Math.max(...channels.map((channel) => channel.id)) + 1
            const channelRecord = (() => {
                builder.reset()
                builder.writeChannel({ ...target, id: newChannelId, topic: newTopic })
                return builder.buffer.slice()
            })()
            let pending: Uint8Array[] = [channelRecord]
            let pendingBytes = channelRecord.length
            let entries: [bigint, bigint][] = []
            let start: bigint | null = null
            let end: bigint | null = null
            const flush = async () => {
                if (entries.length === 0) {
                    return
                }
                const joined = concat(pending)
                newChunkIndexes.push(
                    await writeChunk(
                        emit,
                        () => position,
                        joined,
                        new Map([[newChannelId, entries]]),
                        start!,
                        end!,
                    ),
                )
                pending = []
                pendingBytes = 0
                entries = []
                start = end = null
            }
            const sources = [...reader.chunkIndexes].filter((chunk) => chunk.messageIndexOffsets.has(target.id))
                .sort((a, b) => Number(a.chunkStartOffset - b.chunkStartOffset))
            for (const chunk of sources) {
                const records = chunkRecords(
                    await mcap.read(chunk.chunkStartOffset, chunk.chunkLength),
                )
                for (const { opcode, body } of walk(records)) {
                    if (opcode !== OP.MESSAGE) {
                        continue
                    }
                    const view = new DataView(
                        body.buffer,
                        body.byteOffset,
                        body.byteLength,
                    )
                    if (view.getUint16(0, true) !== target.id) {
                        continue
                    }
                    const logTime = view.getBigUint64(6, true)
                    const message = new Uint8Array(9 + body.length)
                    message[0] = OP.MESSAGE
                    new DataView(message.buffer).setBigUint64(
                        1,
                        BigInt(body.length),
                        true,
                    )
                    message.set(body, 9)
                    new DataView(message.buffer).setUint16(9, newChannelId, true)
                    entries.push([logTime, BigInt(pendingBytes)])
                    pending.push(message)
                    pendingBytes += message.length
                    start = start === null || logTime < start ? logTime : start
                    end = end === null || logTime > end ? logTime : end
                    copied++
                    if (pendingBytes >= CHUNK_TARGET) {
                        await flush()
                    }
                }
            }
            await flush()
        }

        await emit((b) => b.writeDataEnd({ dataSectionCrc: 0 }))

        // ── the summary ──
        const summaryAt = position
        const offsets: {
            groupOpcode: number
            groupStart: bigint
            groupLength: bigint
        }[] = []
        const group = async (
            opcode: number,
            fill: (b: McapRecordBuilder) => void,
        ) => {
            builder.reset()
            fill(builder)
            if (builder.length === 0) {
                return
            }
            offsets.push({
                groupOpcode: opcode,
                groupStart: position,
                groupLength: BigInt(builder.length),
            })
            await write(builder.buffer.slice())
        }
        const keptChannels = channels
            .filter((channel) => !(edit.op === "delete" && channel.id === target.id))
            .map((channel) =>
                channel.id === target.id && edit.op === "rename" ? { ...channel, topic: newTopic } : channel
            )
        if (edit.op === "duplicate") {
            keptChannels.push({ ...target, id: newChannelId, topic: newTopic })
        }
        const usedSchemas = new Set(
            keptChannels.map((channel) => channel.schemaId),
        )
        await group(OP.SCHEMA, (b) => {
            for (const schema of reader.schemasById.values()) {
                if (usedSchemas.has(schema.id)) {
                    b.writeSchema(schema)
                }
            }
        })
        await group(
            OP.CHANNEL,
            (b) => keptChannels.forEach((channel) => b.writeChannel(channel)),
        )
        const stats = reader.statistics
        if (stats) {
            const counts = new Map(stats.channelMessageCounts)
            let messageCount = stats.messageCount
            if (edit.op === "delete") {
                messageCount -= counts.get(target.id) ?? removed
                counts.delete(target.id)
            } else if (edit.op === "duplicate") {
                counts.set(newChannelId, copied)
                messageCount += copied
            }
            const times = newChunkIndexes.filter((chunk) => chunk.messageEndTime > 0n)
            await group(OP.STATISTICS, (b) =>
                b.writeStatistics({
                    ...stats,
                    messageCount,
                    schemaCount: usedSchemas.size,
                    channelCount: keptChannels.length,
                    chunkCount: newChunkIndexes.length,
                    messageStartTime: times.length
                        ? times.reduce(
                            (min, chunk) => chunk.messageStartTime < min ? chunk.messageStartTime : min,
                            times[0].messageStartTime,
                        )
                        : stats.messageStartTime,
                    messageEndTime: times.length
                        ? times.reduce((max, chunk) => chunk.messageEndTime > max ? chunk.messageEndTime : max, 0n)
                        : stats.messageEndTime,
                    channelMessageCounts: counts,
                }))
        }
        await group(
            OP.CHUNK_INDEX,
            (b) => newChunkIndexes.forEach((index) => b.writeChunkIndex(index)),
        )
        await group(
            OP.ATTACHMENT_INDEX,
            (b) => newAttachmentIndexes.forEach((index) => b.writeAttachmentIndex(index)),
        )
        await group(
            OP.METADATA_INDEX,
            (b) => newMetadataIndexes.forEach((index) => b.writeMetadataIndex(index)),
        )
        const summaryOffsetStart = position
        await emit((b) => offsets.forEach((offset) => b.writeSummaryOffset(offset)))
        await emit((b) =>
            b.writeFooter({
                summaryStart: summaryAt,
                summaryOffsetStart,
                summaryCrc: 0,
            })
        )
        await write(MAGIC)
        await out.syncData()
        out.close()
        mcap.close()
        // the original is replaced in one step: a reader sees the old file or the new one, never half of one
        await Deno.rename(temporary, path)
        return {
            messages: Number(
                edit.op === "delete" ? removed : edit.op === "duplicate" ? copied : 0n,
            ),
            chunksRewritten,
        }
    } catch (error) {
        try {
            out.close()
        } catch {
            // closed already
        }
        mcap.close()
        await Deno.remove(temporary).catch(() => {})
        throw error
    }
}

/** Free bytes on the disk holding `dir` (df), or null when that can't be told. */
async function freeBytes(dir: string): Promise<number | null> {
    try {
        const { stdout, success } = await new Deno.Command("df", { args: ["-k", dir], stdout: "piped", stderr: "null" })
            .output()
        if (!success) {
            return null
        }
        const fields = new TextDecoder().decode(stdout).trim().split("\n").pop()!.split(/\s+/)
        const available = Number(fields[3])
        return Number.isFinite(available) ? available * 1024 : null
    } catch {
        return null
    }
}

/** A Chunk record (opcode included) → its records, decompressed. */
function chunkRecords(record: Uint8Array): Uint8Array {
    const view = new DataView(
        record.buffer,
        record.byteOffset,
        record.byteLength,
    )
    let at = 9 + 8 + 8
    const uncompressedSize = Number(view.getBigUint64(at, true))
    at += 8 + 4
    const compressionLength = view.getUint32(at, true)
    const compression = new TextDecoder().decode(
        record.subarray(at + 4, at + 4 + compressionLength),
    )
    at += 4 + compressionLength
    const recordsLength = Number(view.getBigUint64(at, true))
    at += 8
    const body = record.subarray(at, at + recordsLength)
    if (compression === "") {
        return body
    }
    if (compression === "zstd") {
        return zstdDecompress(body, new Uint8Array(uncompressedSize))
    }
    if (compression === "lz4") {
        return new Uint8Array(lz4.decompress(body))
    }
    throw new Error(`unsupported chunk compression ${compression}`)
}

function* walk(
    records: Uint8Array,
): Generator<{ opcode: number; body: Uint8Array; record: Uint8Array }> {
    const view = new DataView(
        records.buffer,
        records.byteOffset,
        records.byteLength,
    )
    let at = 0
    while (at + 9 <= records.length) {
        const opcode = records[at]
        const length = Number(view.getBigUint64(at + 1, true))
        yield {
            opcode,
            body: records.subarray(at + 9, at + 9 + length),
            record: records.subarray(at, at + 9 + length),
        }
        at += 9 + length
    }
}

function parseChannel(body: Uint8Array): Channel {
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
    const decoder = new TextDecoder()
    let at = 0
    const string = () => {
        const length = view.getUint32(at, true)
        const text = decoder.decode(body.subarray(at + 4, at + 4 + length))
        at += 4 + length
        return text
    }
    const id = view.getUint16(0, true)
    const schemaId = view.getUint16(2, true)
    at = 4
    const topic = string()
    const messageEncoding = string()
    const metadata = new Map<string, string>()
    const mapEnd = at + 4 + view.getUint32(at, true)
    at += 4
    while (at < mapEnd) {
        const key = string()
        metadata.set(key, string())
    }
    return { id, schemaId, topic, messageEncoding, metadata }
}

/** A chunk's records with the target's Channel record renamed or dropped and (delete) its messages dropped. */
function editRecords(
    records: Uint8Array,
    targetId: number,
    newTopic: string | null,
    dropMessages: boolean,
) {
    const kept: Uint8Array[] = []
    const entries = new Map<number, [bigint, bigint][]>()
    let bytes = 0
    let changed = false
    let removed = 0n
    let start: bigint | null = null
    let end: bigint | null = null
    for (const { opcode, body, record } of walk(records)) {
        if (opcode === OP.CHANNEL) {
            const channel = parseChannel(body)
            if (channel.id === targetId) {
                changed = true
                if (newTopic === null) {
                    continue
                }
                const builder = new McapRecordBuilder({ padRecords: false })
                builder.writeChannel({ ...channel, topic: newTopic })
                const renamed = builder.buffer.slice()
                kept.push(renamed)
                bytes += renamed.length
                continue
            }
        } else if (opcode === OP.MESSAGE) {
            const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
            const channelId = view.getUint16(0, true)
            if (dropMessages && channelId === targetId) {
                changed = true
                removed++
                continue
            }
            const logTime = view.getBigUint64(6, true)
            let list = entries.get(channelId)
            if (!list) {
                list = []
                entries.set(channelId, list)
            }
            list.push([logTime, BigInt(bytes)])
            start = start === null || logTime < start ? logTime : start
            end = end === null || logTime > end ? logTime : end
        }
        kept.push(record)
        bytes += record.length
    }
    return { changed, removed, records: concat(kept), entries, start, end }
}

async function writeChunk(
    emit: (fill: (b: McapRecordBuilder) => void) => Promise<void>,
    position: () => bigint,
    records: Uint8Array,
    entries: Map<number, [bigint, bigint][]>,
    start: bigint,
    end: bigint,
): Promise<ChunkIndex> {
    const compressed = new Uint8Array(lz4.compress(records))
    const chunkStart = position()
    await emit((b) =>
        b.writeChunk({
            messageStartTime: start,
            messageEndTime: end,
            uncompressedSize: BigInt(records.length),
            uncompressedCrc: 0,
            compression: "lz4",
            records: compressed,
        })
    )
    const chunkLength = position() - chunkStart
    const messageIndexOffsets = new Map<number, bigint>()
    const indexStart = position()
    for (const [channelId, list] of [...entries].sort((a, b) => a[0] - b[0])) {
        messageIndexOffsets.set(channelId, position())
        await emit((b) => b.writeMessageIndex({ channelId, records: list }))
    }
    return {
        messageStartTime: start,
        messageEndTime: end,
        chunkStartOffset: chunkStart,
        chunkLength,
        messageIndexOffsets,
        messageIndexLength: position() - indexStart,
        compression: "lz4",
        compressedSize: BigInt(compressed.length),
        uncompressedSize: BigInt(records.length),
    }
}

function concat(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
    let at = 0
    for (const part of parts) {
        out.set(part, at)
        at += part.length
    }
    return out
}

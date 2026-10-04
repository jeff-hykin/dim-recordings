// Test recordings for the list's date sections and the Foxglove rule, made from real ones (never edits the source):
//   deno run -A scripts/make_test_recordings.ts <out dir> <source.mcap> <source.db>
// - <name>_clip_<when>.mcap: the source .mcap's first seconds, every log time moved so the clip starts <when> ago
//   (today, yesterday, 3 days, 8 days, 20 days). Header stamps inside the messages are left as recorded.
// - <name>_lcm.mcap: the source .db's streams as raw-LCM channels (no schema, like dimos's LCM recorders write),
//   which Foxglove can't draw, shifted to yesterday.
import { DatabaseSync } from "node:sqlite"
import { McapWriter } from "../backend/deps.ts"
import { openMcap } from "../backend/recordings/mcap.ts"
import { unwrapBlob } from "../backend/recordings/messages.ts"

const [out, sourceMcap, sourceDb] = Deno.args
let SECONDS = 8
const DAY = 86400

class FileSink {
    position = 0n
    constructor(public file: Deno.FsFile) {}
    async write(buffer: Uint8Array) {
        await this.file.write(buffer)
        this.position += BigInt(buffer.byteLength)
    }
}

async function writer(path: string) {
    const file = await Deno.open(path, { write: true, create: true, truncate: true })
    const sink = new FileSink(file)
    const mcap = new McapWriter({
        writable: { write: (b: Uint8Array) => sink.write(b), position: () => sink.position },
        useStatistics: true,
        useChunks: true,
        useChunkIndex: true,
        useMessageIndex: true,
        useSummaryOffsets: true,
    })
    await mcap.start({ profile: "", library: "dim-recordings test data" })
    return { mcap, close: () => file.close() }
}

async function clip(source: string, target: string, startsAgo: number) {
    const input = await openMcap(source)
    const { reader } = input
    const first = Number(reader.statistics!.messageStartTime) / 1e9
    const shift = BigInt(Math.round((Date.now() / 1000 - startsAgo - first) * 1e9))
    const { mcap, close } = await writer(target)
    const schemaIds = new Map<number, number>()
    for (const schema of reader.schemasById.values()) {
        schemaIds.set(
            schema.id,
            await mcap.registerSchema({ name: schema.name, encoding: schema.encoding, data: schema.data }),
        )
    }
    const channelIds = new Map<number, number>()
    for (const channel of reader.channelsById.values()) {
        channelIds.set(
            channel.id,
            await mcap.registerChannel({
                topic: channel.topic,
                messageEncoding: channel.messageEncoding,
                schemaId: schemaIds.get(channel.schemaId) ?? 0,
                metadata: channel.metadata,
            }),
        )
    }
    let sequence = 0
    for await (
        const message of reader.readMessages({ endTime: BigInt(Math.round((first + SECONDS) * 1e9)) })
    ) {
        await mcap.addMessage({
            channelId: channelIds.get(message.channelId)!,
            sequence: sequence++,
            logTime: message.logTime + shift,
            publishTime: message.publishTime + shift,
            data: message.data,
        })
    }
    await mcap.end()
    close()
    input.close()
    console.log(`${target}: ${sequence} messages, starts ${startsAgo / DAY} days ago`)
}

async function lcmFromDb(source: string, target: string, startsAgo: number) {
    const db = new DatabaseSync(source, { readOnly: true })
    const streams = db.prepare("SELECT name, config FROM _streams").all() as { name: string; config: string }[]
    const { mcap, close } = await writer(target)
    let first = Infinity
    for (const { name } of streams) {
        const row = db.prepare(`SELECT min(ts) AS t FROM "${name}"`).get() as { t: number | null }
        if (row.t !== null) {
            first = Math.min(first, row.t)
        }
    }
    const shift = Date.now() / 1000 - startsAgo - first
    const rows: { channel: number; ts: number; data: Uint8Array }[] = []
    for (const { name, config } of streams) {
        const type = JSON.parse(config).payload_module.split(".").slice(-3, -1).join(".") // sensor_msgs.Image
        const channel = await mcap.registerChannel({
            topic: `/${name}`,
            messageEncoding: "lcm",
            schemaId: 0,
            metadata: new Map([["type", type]]),
        })
        for (
            const row of db.prepare(
                `SELECT s.ts AS ts, b.data AS data FROM "${name}" s JOIN "${name}_blob" b ON b.id = s.id WHERE s.ts <= ? ORDER BY s.ts`,
            ).all(first + SECONDS) as { ts: number; data: Uint8Array }[]
        ) {
            rows.push({ channel, ts: row.ts, data: unwrapBlob(new Uint8Array(row.data)) })
        }
    }
    rows.sort((a, b) => a.ts - b.ts)
    let sequence = 0
    for (const row of rows) {
        const time = BigInt(Math.round((row.ts + shift) * 1e9))
        await mcap.addMessage({
            channelId: row.channel,
            sequence: sequence++,
            logTime: time,
            publishTime: time,
            data: row.data,
        })
    }
    await mcap.end()
    close()
    db.close()
    console.log(`${target}: ${sequence} raw-LCM messages`)
}

const base = sourceMcap.split("/").pop()!.replace(/\.mcap$/, "")
if (Deno.env.get("UPLOAD_CLIP")) {
    // a small one (2 s) to upload for real: UPLOAD_CLIP=1 → go2_short_clip_upload.mcap, else UPLOAD_CLIP=<name> → <name>.mcap
    SECONDS = 2
    await clip(
        sourceMcap,
        `${out}/${Deno.env.get("UPLOAD_CLIP") === "1" ? `${base}_clip_upload` : Deno.env.get("UPLOAD_CLIP")}.mcap`,
        600,
    )
    Deno.exit(0)
}
const HOUR = 3600
for (
    const [label, ago] of [["today", 2 * HOUR], ["yesterday", DAY + 3 * HOUR], ["3_days_ago", 3 * DAY], [
        "8_days_ago",
        8 * DAY,
    ], ["20_days_ago", 20 * DAY]] as const
) {
    await clip(sourceMcap, `${out}/${base}_clip_${label}.mcap`, ago)
}
if (sourceDb) {
    await lcmFromDb(sourceDb, `${out}/${sourceDb.split("/").pop()!.replace(/\.db$/, "")}_lcm.mcap`, DAY + 6 * HOUR)
}

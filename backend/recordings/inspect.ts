// What's inside a recording: per-stream type, encoding, count, rate and gaps, the tf frame tree (a port of
// `dtk data summary`, tools/db_summary.js), and what looks wrong (warnings.ts). Reads indexes and timestamps, a .db's
// whole tf stream (an .mcap's tf in windows across it), and each stream's first message for its frame.
import { openDb } from "./sqlite.ts"
import { decodeCdrFrames, decodeLcmFrames, type Edge, readCdrFrameId, readLcmFrameId, unwrapBlob } from "./messages.ts"
import { logTimesFromIndexes, openMcap } from "./mcap.ts"
import { type EdgeSpan, streamWarnings, tfWarnings, type Warning } from "./warnings.ts"

export type StreamInfo = {
    name: string
    /** short message type: sensor_msgs.Image, nav_msgs.Odometry, ... */
    type: string
    /** how payloads are encoded: a .db stream's codec (lcm, lz4+lcm, jpeg), an .mcap channel's (cdr, lcm, json) */
    encoding: string
    /** an .mcap channel has a non-empty schema attached */
    hasSchema: boolean
    count: number
    start: number | null
    end: number | null
    duration: number
    hz: number
    p99Gap: number
    p99Ratio: number
    maxGap: number
    gapRatio: number
}

export type TfTree = {
    /** which streams it came from ("tf + tf_static"), null when the recording has no tf */
    source: string | null
    /** how much of it was read: "all of it" (a .db), "16 windows of 1 s, every 31 s" (an .mcap) */
    coverage: string
    messages: number
    /** each parent → child with its count, first and last time, and rate (0 when static) over what was read */
    edges: EdgeSpan[]
    roots: string[]
    /** frames with more than one parent: tf allows exactly one */
    conflicts: { frame: string; parents: { parent: string; count: number }[] }[]
}

export type Inspection = {
    format: "db" | "mcap"
    start: number | null
    end: number | null
    duration: number | null
    messages: number
    streams: StreamInfo[]
    tf: TfTree
    /** what looks wrong, worst first: a broken tf tree, outlier gaps, rate drops, streams that start late or stop early */
    warnings: Warning[]
    /** a short line for the list: "1 camera · 2 point clouds · odometry · tf" */
    summary: string
    error?: string
}

/** dimos.msgs.sensor_msgs.Image.Image, sensor_msgs/msg/Image, sensor_msgs.Image → sensor_msgs.Image */
export function shortType(name: string): string {
    if (!name) {
        return ""
    }
    const parts = name.split(/[./]/).filter((part) => part && part !== "msg" && part !== "msgs")
    if (parts[0] === "dimos") {
        parts.shift()
    }
    // dimos modules repeat the class: sensor_msgs.Image.Image
    if (parts.length >= 2 && parts[parts.length - 1] === parts[parts.length - 2]) {
        parts.pop()
    }
    return parts.slice(-2).join(".")
}

export function gapStats(name: string, count: number, times: number[]) {
    let start: number | null = null
    let end: number | null = null
    let maxGap = 0
    let p99Gap = 0
    if (count > 0 && times.length > 0) {
        start = times[0]
        end = times[times.length - 1]
    }
    if (times.length > 1) {
        const gaps = new Float64Array(times.length - 1)
        for (let i = 1; i < times.length; i++) {
            gaps[i - 1] = times[i] - times[i - 1]
        }
        gaps.sort()
        maxGap = gaps[gaps.length - 1]
        p99Gap = gaps[Math.min(gaps.length - 1, Math.max(0, Math.ceil(gaps.length * 0.99) - 1))]
    }
    const duration = start !== null && end !== null ? end - start : 0
    const hz = duration > 0 ? count / duration : 0
    const meanGap = count > 1 && duration > 0 ? duration / (count - 1) : 0
    return {
        name,
        count,
        start,
        end,
        duration,
        hz,
        p99Gap,
        p99Ratio: meanGap > 0 && p99Gap > 0 ? p99Gap / meanGap : 0,
        maxGap,
        gapRatio: meanGap > 0 && maxGap > 0 ? maxGap / meanGap : 0,
    }
}

const KINDS: [RegExp, string, string][] = [
    [/(^|\.)(Image|CompressedImage)$/, "camera", "cameras"],
    [/PointCloud2$/, "point cloud", "point clouds"],
    [/(Odometry|PoseStamped)$/, "odometry", "odometry"],
    [/(LaserScan)$/, "laser scan", "laser scans"],
    [/(Imu)$/, "IMU", "IMUs"],
    [/(OccupancyGrid|Costmap)$/, "map", "maps"],
]

/** "2 cameras · point cloud · odometry · tf · 3 other" (non-empty streams only; camera_info isn't counted) */
export function streamSummary(streams: Pick<StreamInfo, "name" | "type" | "count">[]): string {
    const counts = new Map<string, number>()
    let tf = false
    let other = 0
    for (const stream of streams) {
        if (stream.count === 0 || /CameraInfo$/.test(stream.type)) {
            continue
        }
        if (/TFMessage$/.test(stream.type)) {
            tf = true
            continue
        }
        const kind = KINDS.find(([pattern]) => pattern.test(stream.type))
        if (kind) {
            counts.set(kind[1], (counts.get(kind[1]) ?? 0) + 1)
        } else {
            other++
        }
    }
    const parts: string[] = []
    for (const [, one, many] of KINDS) {
        const n = counts.get(one)
        if (n) {
            parts.push(n === 1 ? one : one === "odometry" ? `${n} odometry` : `${n} ${many}`)
        }
    }
    if (tf) {
        parts.push("tf")
    }
    if (other) {
        parts.push(`${other} other`)
    }
    return parts.join(" · ") || "empty"
}

/** One read of a tf stream: when, which edges, from a static stream or not, and which window it was read in. */
export type TfSample = { time: number; edges: Edge[]; static: boolean; window: number }

export function buildTree(source: string | null, coverage: string, samples: TfSample[]): TfTree {
    type Acc = {
        count: number
        first: number
        last: number
        static: boolean
        windows: Map<number, [number, number, number]>
    }
    const byKey = new Map<string, Acc>()
    const parentsOf = new Map<string, Map<string, number>>()
    for (const sample of samples) {
        for (const { parent, child } of sample.edges) {
            const key = `${parent}\n${child}`
            let acc = byKey.get(key)
            if (!acc) {
                acc = { count: 0, first: Infinity, last: -Infinity, static: true, windows: new Map() }
                byKey.set(key, acc)
            }
            acc.count++
            acc.first = Math.min(acc.first, sample.time)
            acc.last = Math.max(acc.last, sample.time)
            acc.static &&= sample.static
            const span = acc.windows.get(sample.window)
            if (span) {
                span[0]++
                span[1] = Math.min(span[1], sample.time)
                span[2] = Math.max(span[2], sample.time)
            } else {
                acc.windows.set(sample.window, [1, sample.time, sample.time])
            }
            const seen = parentsOf.get(child) ?? new Map<string, number>()
            seen.set(parent, (seen.get(parent) ?? 0) + 1)
            parentsOf.set(child, seen)
        }
    }
    const edges: EdgeSpan[] = [...byKey].map(([key, acc]) => {
        const [parent, child] = key.split("\n")
        // a rate within each window read, so the stretches between windows don't count as silence
        let intervals = 0
        let time = 0
        for (const [count, first, last] of acc.windows.values()) {
            intervals += count - 1
            time += last - first
        }
        return {
            parent,
            child,
            count: acc.count,
            first: acc.first,
            last: acc.last,
            hz: acc.static || time <= 0 ? 0 : intervals / time,
            static: acc.static,
        }
    }).sort((a, b) => a.parent.localeCompare(b.parent) || a.child.localeCompare(b.child))
    const children = new Set(edges.map((edge) => edge.child))
    const roots = [...new Set(edges.map((edge) => edge.parent))].filter((frame) => !children.has(frame)).sort()
    const conflicts = [...parentsOf].filter(([, seen]) => seen.size > 1).map(([frame, seen]) => ({
        frame,
        parents: [...seen].map(([parent, count]) => ({ parent, count })).sort((a, b) => b.count - a.count),
    }))
    return { source, coverage, messages: samples.length, edges, roots, conflicts }
}

/** tf + tf_static when present (a rival TFMessage stream is another estimate, not more of this tree), else the first TFMessage stream */
function tfStreams(streams: StreamInfo[]): string[] {
    const canonical = ["tf", "tf_static"].filter((name) => streams.some((s) => s.name === name && s.count > 0))
    if (canonical.length) {
        return canonical
    }
    const any = streams.find((s) => /TFMessage$/.test(s.type) && s.count > 0)
    return any ? [any.name] : []
}

const ORDER = ["two parents", "cycle", "forest", "unplaced", "stops early", "starts late", "gap", "rate drop"]

function finish(
    format: "db" | "mcap",
    streams: StreamInfo[],
    tf: TfTree,
    timesOf: (name: string) => number[],
    headerFrames: Map<string, string>,
    sampledEvery = 0,
    sampledWindow = 0,
): Inspection {
    const starts = streams.map((s) => s.start).filter((t): t is number => t !== null)
    const ends = streams.map((s) => s.end).filter((t): t is number => t !== null)
    const start = starts.length ? Math.min(...starts) : null
    const end = ends.length ? Math.max(...ends) : null
    const steady = streams.filter((s) => s.count >= 20 && s.start !== null && s.end !== null)
    const middle = (values: number[]) => values.sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)]
    const usualStart = steady.length ? middle(steady.map((s) => s.start!)) : start
    const usualEnd = steady.length ? middle(steady.map((s) => s.end!)) : end
    const warnings = [
        ...tfWarnings(tf.edges, start, end, headerFrames, sampledEvery, sampledWindow),
        ...streams.flatMap((s) =>
            streamWarnings(s.name, timesOf(s.name), start, end, usualStart, usualEnd, /TFMessage$/.test(s.type))
        ),
    ]
    const rank = (w: Warning) => {
        const at = ORDER.indexOf(w.kind)
        return (w.message.startsWith("TF:") ? 0 : 100) + (at < 0 ? 50 : at)
    }
    warnings.sort((a, b) => rank(a) - rank(b))
    return {
        format,
        start,
        end,
        duration: start !== null && end !== null ? end - start : null,
        messages: streams.reduce((sum, s) => sum + s.count, 0),
        streams,
        tf,
        warnings,
        summary: streamSummary(streams),
    }
}

/** an .mcap's tf is read in this many windows of TF_WINDOW seconds across it (a whole read decompresses every chunk) */
const TF_WINDOWS = 16
const TF_WINDOW = 1

export function inspectDb(path: string): Inspection {
    const db = openDb(path)
    try {
        const rows = db.prepare("SELECT name, config FROM _streams ORDER BY name").all() as {
            name: string
            config: string
        }[]
        const tables = new Set(
            (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) =>
                r.name
            ),
        )
        const streams: StreamInfo[] = []
        const timesByName = new Map<string, number[]>()
        for (const { name, config } of rows) {
            let payload = ""
            let codec = ""
            try {
                const parsed = JSON.parse(config)
                payload = parsed?.payload_module ?? ""
                codec = parsed?.codec_id ?? ""
            } catch {
                // a config that isn't JSON: the stream still has rows
            }
            const quoted = name.replaceAll('"', '""')
            let times: number[] = []
            try {
                times = (db.prepare(`SELECT ts FROM "${quoted}" ORDER BY ts`).all() as { ts: number }[]).map((r) =>
                    r.ts
                )
            } catch {
                // a stream registered without its table
            }
            timesByName.set(name, times)
            streams.push({
                ...gapStats(name, times.length, times),
                type: shortType(payload),
                encoding: codec,
                hasSchema: true,
            })
        }
        const names = tfStreams(streams)
        const samples: TfSample[] = []
        for (const name of names) {
            const quoted = name.replaceAll('"', '""')
            const isStatic = name.endsWith("_static")
            try {
                const blobs = db.prepare(
                    `SELECT s.ts AS ts, b.data AS data FROM "${quoted}" AS s JOIN "${quoted}_blob" AS b ON b.id = s.id ORDER BY s.ts`,
                ).all() as { ts: number; data: Uint8Array }[]
                for (const { ts, data } of blobs) {
                    samples.push({
                        time: ts,
                        edges: decodeLcmFrames(unwrapBlob(new Uint8Array(data))),
                        static: isStatic,
                        window: 0,
                    })
                }
            } catch {
                // blobs kept somewhere else (a file blob store): no tree
            }
        }
        const headerFrames = new Map<string, string>()
        for (const stream of streams) {
            const quoted = stream.name.replaceAll('"', '""')
            if (names.includes(stream.name) || !stream.count || !tables.has(`${stream.name}_blob`)) {
                continue
            }
            if (stream.encoding && !stream.encoding.includes("lcm")) {
                continue // jpeg frames carry no header
            }
            try {
                const first = db.prepare(
                    `SELECT b.data AS data FROM "${quoted}" AS s JOIN "${quoted}_blob" AS b ON b.id = s.id ORDER BY s.ts LIMIT 1`,
                ).get() as { data: Uint8Array } | undefined
                const frame = first ? readLcmFrameId(unwrapBlob(new Uint8Array(first.data))) : null
                if (frame) {
                    headerFrames.set(stream.name, frame)
                }
            } catch {
                // an undecodable first message: no frame to check
            }
        }
        return finish(
            "db",
            streams,
            buildTree(names.length ? names.join(" + ") : null, "all of it", samples),
            (name) => timesByName.get(name) ?? [],
            headerFrames,
        )
    } finally {
        db.close()
    }
}

export async function inspectMcap(path: string): Promise<Inspection> {
    const mcap = await openMcap(path)
    try {
        const { reader } = mcap
        const channels = [...reader.channelsById.values()].sort((a, b) => a.topic.localeCompare(b.topic))
        let timesById = await logTimesFromIndexes(mcap)
        if (timesById === null) {
            timesById = new Map(channels.map((channel) => [channel.id, [] as number[]]))
            for await (const message of reader.readMessages()) {
                timesById.get(message.channelId)?.push(Number(message.logTime) / 1e9)
            }
        }
        const streams: (StreamInfo & { channel: typeof channels[number] })[] = []
        const timesByName = new Map<string, number[]>()
        for (const channel of channels) {
            const schema = reader.schemasById.get(channel.schemaId)
            const times = (timesById.get(channel.id) ?? []).sort((a, b) => a - b)
            const count = Number(reader.statistics?.channelMessageCounts.get(channel.id) ?? times.length)
            // a raw-LCM channel has no schema; its type rides in the channel metadata
            const typeName = schema?.name ?? channel.metadata.get("type") ?? channel.metadata.get("lcm_type") ?? ""
            const name = channel.topic.replace(/^\//, "")
            timesByName.set(name, times)
            streams.push({
                ...gapStats(name, count, times),
                type: shortType(typeName),
                encoding: channel.messageEncoding,
                hasSchema: !!schema && schema.data.byteLength > 0,
                channel,
            })
        }
        const names = tfStreams(streams)
        const samples: TfSample[] = []
        const starts = streams.map((s) => s.start).filter((t): t is number => t !== null)
        const ends = streams.map((s) => s.end).filter((t): t is number => t !== null)
        const start = starts.length ? Math.min(...starts) : 0
        const end = ends.length ? Math.max(...ends) : 0
        // windows at the start, the end and evenly between, so a tf edge that stops or starts partway shows up
        const windows: [number, number][] = []
        const span = end - start
        if (span <= TF_WINDOWS * TF_WINDOW) {
            windows.push([start, end])
        } else {
            for (let i = 0; i < TF_WINDOWS; i++) {
                const from = start + (span - TF_WINDOW) * i / (TF_WINDOWS - 1)
                windows.push([from, from + TF_WINDOW])
            }
        }
        const sampledEvery = windows.length > 1 ? (span - TF_WINDOW) / (TF_WINDOWS - 1) : 0
        for (const name of names) {
            const stream = streams.find((s) => s.name === name)!
            const isStatic = name.endsWith("_static")
            const decode = stream.encoding === "cdr" ? decodeCdrFrames : decodeLcmFrames
            const ranges: ([number, number] | null)[] = isStatic ? [null] : windows
            for (const [index, range] of ranges.entries()) {
                const window = range
                    ? {
                        startTime: BigInt(Math.floor(range[0] * 1e9)),
                        endTime: BigInt(Math.ceil(range[1] * 1e9)),
                    }
                    : {}
                try {
                    for await (const message of reader.readMessages({ topics: [stream.channel.topic], ...window })) {
                        samples.push({
                            time: Number(message.logTime) / 1e9,
                            edges: decode(message.data),
                            static: isStatic,
                            window: index,
                        })
                    }
                } catch {
                    // an undecodable tf channel: no tree
                }
            }
        }
        const headerFrames = new Map<string, string>()
        for (const stream of streams) {
            if (names.includes(stream.name) || !stream.count || !["cdr", "lcm"].includes(stream.encoding)) {
                continue
            }
            const read = stream.encoding === "cdr" ? readCdrFrameId : readLcmFrameId
            try {
                for await (const message of reader.readMessages({ topics: [stream.channel.topic] })) {
                    const frame = read(message.data)
                    if (frame) {
                        headerFrames.set(stream.name, frame)
                    }
                    break // the first message is enough; a stream does not change frame
                }
            } catch {
                // an undecodable first message: no frame to check
            }
        }
        const plain = streams.map(({ channel: _channel, ...rest }) => rest)
        const coverage = windows.length > 1
            ? `${TF_WINDOWS} windows of ${TF_WINDOW} s, every ${Math.round(sampledEvery)} s`
            : "all of it"
        return finish(
            "mcap",
            plain,
            buildTree(names.length ? names.join(" + ") : null, coverage, samples),
            (name) => timesByName.get(name) ?? [],
            headerFrames,
            sampledEvery,
            windows.length > 1 ? TF_WINDOW : 0,
        )
    } finally {
        mcap.close()
    }
}

/** Decides by the file's first bytes, not its name (an .mcap starts with \x89MCAP). */
export async function formatOf(path: string): Promise<"db" | "mcap" | "rrd" | null> {
    const file = await Deno.open(path, { read: true })
    try {
        const head = new Uint8Array(16)
        const got = (await file.read(head)) ?? 0
        const text = new TextDecoder().decode(head.subarray(0, got))
        if (text.startsWith("\x89MCAP") || head[0] === 0x89 && text.slice(1, 5) === "MCAP") {
            return "mcap"
        }
        if (text.startsWith("SQLite format 3")) {
            return "db"
        }
        if (text.startsWith("RRF2") || text.startsWith("RRF")) {
            return "rrd"
        }
        return null
    } finally {
        file.close()
    }
}

export async function inspect(path: string): Promise<Inspection> {
    const format = await formatOf(path)
    if (format === "mcap") {
        return await inspectMcap(path)
    }
    if (format === "db") {
        return inspectDb(path)
    }
    throw new Error(`not a .db or .mcap recording: ${path}`)
}

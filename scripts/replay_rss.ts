// Peak memory of the backend while a recording is opened, scrubbed end to end, played and paused in the Replayer:
// starts the backend on a folder, plays it over the same websocket the page uses, and samples the backend's RSS
// (ps) every 100 ms. `deno run -A scripts/replay_rss.ts <recordings dir> <recording id> [--port 8798]`
const [dir, id] = Deno.args.filter((arg) => !arg.startsWith("--"))
const port = Number(Deno.args[Deno.args.indexOf("--port") + 1]) || 8798
if (!dir || !id) {
    console.error("usage: replay_rss.ts <recordings dir> <recording id>")
    Deno.exit(1)
}
const data = await Deno.makeTempDir({ prefix: "replay_rss_" })
const backend = new Deno.Command(Deno.execPath(), {
    args: [
        "run",
        "-A",
        new URL("../backend/main.ts", import.meta.url).pathname,
        "--port",
        String(port),
        "--recordings-dir",
        dir,
        "--data-dir",
        data,
        "--no-thumbnails",
    ],
    stdout: "null",
    stderr: "null",
}).spawn()
const base = `http://localhost:${port}`
for (let i = 0; i < 100; i++) {
    try {
        await fetch(`${base}/agent.json`).then((r) => r.body?.cancel())
        break
    } catch {
        await new Promise((r) => setTimeout(r, 100))
    }
}
const rssMb = async () => {
    const out = await new Deno.Command("ps", {
        args: ["-o", "rss=", "-p", String(backend.pid)],
    }).output()
    return Number(new TextDecoder().decode(out.stdout).trim()) / 1024
}
let peak = 0
const samples: [string, number][] = []
let phase = "start"
const sampler = setInterval(async () => {
    const mb = await rssMb()
    peak = Math.max(peak, mb)
    samples.push([phase, mb])
}, 100)
const size = (await Deno.stat(`${dir}/${id}`)).size
const log = (text: string) =>
    console.log(
        `${text.padEnd(46)} rss ${samples.at(-1)?.[1].toFixed(0) ?? "?"} MB, peak ${peak.toFixed(0)} MB`,
    )
log(`backend up (${id}, ${(size / 1e9).toFixed(2)} GB)`)

phase = "open"
const t0 = performance.now()
const info = await (await fetch(`${base}/api/replay/${encodeURIComponent(id)}`))
    .json()
log(
    `opened in ${((performance.now() - t0) / 1000).toFixed(1)} s: ${info.streams.length} streams, ${
        (info.end - info.start).toFixed(0)
    } s`,
)
await (await fetch(`${base}/api/replay/${encodeURIComponent(id)}/timeline`))
    .json()
log("timeline (every stream's ticks)")

const ws = new WebSocket(
    `ws://localhost:${port}/api/replay/${encodeURIComponent(id)}/ws`,
)
ws.binaryType = "arraybuffer"
let waiting: (() => void) | null = null
let received = 0
ws.onmessage = (event) => {
    if (typeof event.data === "string") {
        const message = JSON.parse(event.data)
        if (message.op === "done" && !message.skipped) {
            waiting?.()
            waiting = null
        }
        return
    }
    received += (event.data as ArrayBuffer).byteLength
}
await new Promise((resolve) => (ws.onopen = resolve))
// what the page subscribes to by default: every image (camera panels), cloud, pose and tf stream
let subId = 0
for (const stream of info.streams) {
    const as = stream.kind === "image" ? "image" : stream.kind === "cloud" ? "cloud" : "lcm"
    if (
        ["image", "cloud", "pose", "tf", "info"].includes(stream.kind) &&
        stream.count > 0
    ) {
        ws.send(
            JSON.stringify({ op: "sub", id: subId++, stream: stream.name, as }),
        )
    }
}
let seq = 0
const at = (t: number, mode: string) =>
    new Promise<void>((resolve) => {
        waiting = resolve
        ws.send(JSON.stringify({ op: "at", t, mode, seq: ++seq }))
    })
phase = "scrub"
const span = info.end - info.start
let t1 = performance.now()
for (let i = 0; i <= 200; i++) {
    await at(info.start + (span * i) / 200, "scrub")
}
log(
    `scrubbed start→end, 200 stops, ${((performance.now() - t1) / 1000).toFixed(1)} s, ${
        (received / 1e6).toFixed(0)
    } MB sent`,
)
for (let i = 200; i >= 0; i -= 4) {
    await at(info.start + (span * i) / 200, "scrub")
}
log("scrubbed back")
phase = "play"
t1 = performance.now()
for (let i = 0; i < 600; i++) {
    await at(info.start + span / 2 + i / 30, "play")
}
log(
    `played 20 s from the middle (${((performance.now() - t1) / 1000).toFixed(1)} s wall)`,
)
phase = "pause"
await at(info.start + span * 0.9, "pause")
log("paused at 90% (full-res frames)")
await new Promise((r) => setTimeout(r, 500))
clearInterval(sampler)
ws.close()
backend.kill()
await backend.status
await Deno.remove(data, { recursive: true }).catch(() => {})
const byPhase: Record<string, number> = {}
for (const [name, mb] of samples) {
    byPhase[name] = Math.max(byPhase[name] ?? 0, mb)
}
console.log(
    JSON.stringify({
        recording: id,
        fileGB: +(size / 1e9).toFixed(2),
        peakRssMB: +peak.toFixed(0),
        peakByPhaseMB: Object.fromEntries(
            Object.entries(byPhase).map(([k, v]) => [k, +v.toFixed(0)]),
        ),
        ratio: +(peak * 1e6 / size).toFixed(4),
    }),
)

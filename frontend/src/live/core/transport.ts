// The Replayer's stand-in for the Controller's gateway connection (same interface, so the Controller's layers, TF feed
// and panels run unchanged): topics are the recording's streams, `subscribe` asks the backend's playback websocket
// (backend/replay/player.ts) for a stream, and the clock is the playhead, not the wall. The page owns the playhead:
// each animation frame it tells the backend where it is (`at`) and in which mode (play / scrub / pause), one request
// in flight at a time.
import { Store } from "./store.ts"

export interface Topic {
    /** dimos/<stream>/<type>, like the live gateway's keys */
    key: string
    /** the stream name with a leading slash, e.g. /lidar */
    name: string
    /** the message type, e.g. sensor_msgs.PointCloud2 */
    type: string
}

export interface Message {
    key: string
    /** dimos LCM bytes (raw subscriptions) */
    bytes: Uint8Array
    /** the message's recording time, in ms */
    timestamp: number
    seq: number
    /** encoding subscriptions: a cloud ({positions, intensity}) or a frame (see video.ts) */
    decoded?: unknown
    /** "low" while scrubbing (thumbnail image, thinned cloud), else "full" */
    quality?: "low" | "full"
}

export interface SubscribeOptions {
    delivery?: "latest" | "reliable"
    priority?: number
    maxHz?: number
    minQuality?: number
    /** dimos_lcm_pointcloud2 → a decoded cloud; *_image / *_depth → a decoded frame; none → LCM bytes */
    encoding?: string
}

export const Priority = { low: 0, normal: 1, high: 2 }

export function parseKey(key: string): Topic | null {
    const parts = key.split("/")
    if (parts.length < 3 || parts[0] !== "dimos") {
        return null
    }
    return {
        key,
        name: "/" + parts.slice(1, -1).join("/"),
        type: parts[parts.length - 1],
    }
}

export const dimosKey = (topic: string, type: string) => `dimos/${topic.replace(/^\/+/, "")}/${type}`

export interface ConnectionState {
    state: "connecting" | "connected" | "degraded" | "lost"
    topics: Topic[]
    droppedPerSecond: number
    rttMs: number | null
    error: string | null
}

export type Mode = "play" | "scrub" | "pause"

export interface Playhead {
    /** recording time, seconds since the epoch (the recording's own clock) */
    t: number
    start: number
    end: number
    playing: boolean
    scrubbing: boolean
    speed: number
    loop: boolean
}

export interface StreamInfo {
    name: string
    type: string
    kind: "image" | "cloud" | "tf" | "pose" | "info" | "other"
    encoding: string
    count: number
    start: number | null
    end: number | null
}

/** seconds of playhead, for things that age by time (point-cloud windows): the replay clock, not the wall */
let mediaSecondsNow = () => performance.now() / 1000
export const mediaSeconds = () => mediaSecondsNow()

type As = "lcm" | "image" | "cloud" | "header"

interface Subscription {
    id: number
    key: string
    stream: string
    as: As
    maxHz: number
    onMessage: (message: Message) => void
    /** the latest message, so a second subscriber to the same thing gets it at once (like a live topic's sample) */
}

/** while scrubbing, a playhead that holds still this long gets full-quality frames */
const SETTLE_MS = 350

export class Connection {
    readonly status = new Store<ConnectionState>({
        state: "connecting",
        topics: [],
        droppedPerSecond: 0,
        rttMs: null,
        error: null,
    })
    readonly playhead: Store<Playhead>
    readonly streams: StreamInfo[]
    /** fired when the playhead jumps (a seek, a scrub, a loop): layers that accumulate start over */
    readonly onSeek = new Set<() => void>()
    #ws: WebSocket | null = null
    #subs = new Map<number, Subscription>()
    #nextId = 1
    #seq = 0
    #inFlight: { seq: number; at: number; t: number; mode: Mode } | null = null
    #sent: { t: number; mode: Mode } | null = null
    #lastFrame = 0
    #stillSince = 0
    #lastT = 0
    #raf = 0
    #closed = false
    /** the backend's answer time for the last request (ms), for the stats pill */
    rttMs: number | null = null

    constructor(
        readonly recordingId: string,
        overview: { start: number; end: number; streams: StreamInfo[] },
        initial?: Partial<Playhead>,
    ) {
        this.streams = overview.streams
        this.playhead = new Store<Playhead>({
            t: overview.start,
            start: overview.start,
            end: overview.end,
            playing: false,
            scrubbing: false,
            speed: 1,
            loop: false,
            ...initial,
        })
        this.#lastT = this.playhead.get().t
        mediaSecondsNow = () => this.playhead.get().t - overview.start
        const topics = overview.streams
            .filter((stream) => stream.count > 0)
            .map((stream) => ({
                key: dimosKey(stream.name, stream.type),
                name: "/" + stream.name,
                type: stream.type,
            }))
            .sort((a, b) => a.name.localeCompare(b.name))
        this.status.update({ topics })
        this.playhead.subscribe(() => this.#onPlayhead())
    }

    start() {
        this.#open()
        const loop = (now: number) => {
            if (this.#closed) {
                return
            }
            this.#frame(now)
            this.#raf = requestAnimationFrame(loop)
        }
        this.#raf = requestAnimationFrame(loop)
    }

    close() {
        this.#closed = true
        cancelAnimationFrame(this.#raf)
        this.#ws?.close()
    }

    #open() {
        const url = new URL(
            `api/replay/${encodeURIComponent(this.recordingId)}/ws`,
            location.href,
        )
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
        const ws = new WebSocket(url)
        ws.binaryType = "arraybuffer"
        this.#ws = ws
        ws.onopen = () => {
            this.status.update({ state: "connected", error: null })
            for (const sub of this.#subs.values()) {
                this.#sendSub(sub)
            }
            this.#inFlight = null
            this.#sent = null
        }
        ws.onclose = () => {
            if (this.#closed) {
                return
            }
            this.status.update({ state: "lost" })
            setTimeout(() => !this.#closed && this.#open(), 1500)
        }
        ws.onmessage = (event) => {
            if (typeof event.data === "string") {
                this.#onText(JSON.parse(event.data))
            } else {
                this.#onPacket(new Uint8Array(event.data as ArrayBuffer))
            }
        }
    }

    // deno-lint-ignore no-explicit-any
    #onText(message: any) {
        if (message.op === "done") {
            if (this.#inFlight && message.seq === this.#inFlight.seq) {
                this.rttMs = performance.now() - this.#inFlight.at
                this.#inFlight = null
            }
        } else if (message.op === "reload") {
            this.onReload?.()
        } else if (message.op === "error") {
            this.status.update({ error: String(message.error) })
        }
    }

    /** the recording changed on disk (a stream edit): the page re-reads it */
    onReload: (() => void) | null = null

    #onPacket(bytes: Uint8Array) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        const headerLength = view.getUint32(0, true)
        const header = JSON.parse(
            new TextDecoder().decode(bytes.subarray(4, 4 + headerLength)),
        )
        const payload = bytes.subarray(4 + headerLength)
        const sub = this.#subs.get(header.s)
        if (!sub) {
            return
        }
        const message: Message = {
            key: sub.key,
            bytes: payload,
            timestamp: header.t * 1000,
            seq: header.i,
            quality: header.q,
        }
        if (header.k === "cloud") {
            const n = header.n as number
            // the payload sits 4-byte aligned (the header is padded), so the floats can be viewed in place
            const positions = new Float32Array(
                payload.buffer,
                payload.byteOffset,
                n * 3,
            )
            const intensity = header.i ? payload.subarray(n * 12, n * 12 + n) : undefined
            message.decoded = {
                positions,
                intensity,
                frame: header.frame,
                sourceCount: header.source,
            }
        } else if (header.k === "image" || header.k === "depth") {
            message.decoded = {
                kind: header.k,
                width: header.w,
                height: header.h,
                encoding: header.enc,
                frame: header.frame,
                data: payload,
            }
        }
        sub.onMessage(message)
    }

    #sendSub(sub: Subscription) {
        if (this.#ws?.readyState === WebSocket.OPEN) {
            this.#ws.send(
                JSON.stringify({
                    op: "sub",
                    id: sub.id,
                    stream: sub.stream,
                    as: sub.as,
                    maxHz: sub.maxHz,
                }),
            )
        }
    }

    subscribe(
        key: string,
        options: SubscribeOptions,
        onMessage: (message: Message) => void,
    ): () => void {
        const topic = parseKey(key)
        const stream = topic ? topic.name.slice(1) : key
        const heavy = topic &&
            /(Image|CompressedImage|PointCloud2)$/.test(topic.type)
        const encoding = options.encoding ?? ""
        const as: As = encoding.endsWith("pointcloud2")
            ? "cloud"
            : /(image|depth)$/.test(encoding)
            ? "image"
            : heavy
            ? "header"
            : "lcm"
        const sub: Subscription = {
            id: this.#nextId++,
            key,
            stream,
            as,
            maxHz: options.maxHz ?? 0,
            onMessage,
        }
        this.#subs.set(sub.id, sub)
        this.#sendSub(sub)
        return () => {
            this.#subs.delete(sub.id)
            if (this.#ws?.readyState === WebSocket.OPEN) {
                this.#ws.send(JSON.stringify({ op: "unsub", id: sub.id }))
            }
        }
    }

    /** the playhead in ms: what the Controller calls the gateway clock (message timestamps are in it) */
    bridgeNow(): number {
        return this.playhead.get().t * 1000
    }

    // ── the clock ──

    play() {
        const head = this.playhead.get()
        this.playhead.update({
            playing: true,
            t: head.t >= head.end ? head.start : head.t,
        })
    }
    pause() {
        this.playhead.update({ playing: false })
    }
    seek(t: number) {
        const head = this.playhead.get()
        this.playhead.update({ t: Math.min(head.end, Math.max(head.start, t)) })
    }

    #onPlayhead() {
        const t = this.playhead.get().t
        const playing = this.playhead.get().playing &&
            !this.playhead.get().scrubbing
        // anything but smooth forward playback is a jump
        if (!playing || t < this.#lastT || t - this.#lastT > 1.5) {
            if (t !== this.#lastT) {
                for (const listener of this.onSeek) {
                    listener()
                }
            }
        }
        this.#lastT = t
    }

    #frame(now: number) {
        const head = this.playhead.get()
        const dt = this.#lastFrame ? Math.min(0.25, (now - this.#lastFrame) / 1000) : 0
        this.#lastFrame = now
        if (head.playing && !head.scrubbing) {
            let t = head.t + dt * head.speed
            if (t >= head.end) {
                if (head.loop) {
                    t = head.start
                } else {
                    t = head.end
                    this.playhead.update({ t, playing: false })
                    return
                }
            }
            this.playhead.update({ t })
        }
        // a timed-out request (the socket hiccuped) frees the line
        if (this.#inFlight && now - this.#inFlight.at > 5000) {
            this.#inFlight = null
        }
        if (this.#ws?.readyState !== WebSocket.OPEN) {
            return
        }
        const current = this.playhead.get()
        let mode: Mode = current.scrubbing ? "scrub" : current.playing ? "play" : "pause"
        if (mode === "scrub") {
            if (!this.#sent || this.#sent.t !== current.t) {
                this.#stillSince = now
            } else if (now - this.#stillSince > SETTLE_MS) {
                mode = "pause" // held still mid-scrub: full quality
            }
        }
        // one request in flight, except that a new mode (a scrub grabbed mid-play, its release) goes at once: the
        // backend drops the old one's remaining streams for it
        if (this.#inFlight && this.#inFlight.mode === mode) {
            return
        }
        if (this.#sent && this.#sent.t === current.t && this.#sent.mode === mode) {
            return
        }
        const seq = ++this.#seq
        this.#inFlight = { seq, at: now, t: current.t, mode }
        this.#sent = { t: current.t, mode }
        this.#ws.send(
            JSON.stringify({
                op: "at",
                t: current.t,
                mode,
                seq,
                speed: current.speed,
            }),
        )
    }
}

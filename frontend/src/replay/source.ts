// The Replayer's data source for dimos-react (the same `{ subscribe, listTopics, state, onState, now, ... }` shape as
// its live zenoh source, so the library's 3D layers and image views run unchanged): topics are the recording's
// streams, `subscribe` asks the backend's playback websocket (backend/replay/player.ts) for a stream, and the clock is
// the playhead, not the wall. The page owns the playhead: each animation frame it tells the backend where it is (`at`)
// and in which mode (play / scrub / pause), one request in flight at a time. Backend events (frontendtopics) still come
// from Desktop's zenoh-gateway.
import { dimosKey, keyMatches, parseKey, zenohSource } from "dimos-react"
import { Store, type TypedStore } from "./store.ts"

export type Mode = "play" | "scrub" | "pause"
export type ConnectionState = "connecting" | "connected" | "degraded" | "lost"

export interface StreamInfo {
    name: string
    type: string
    kind: "image" | "cloud" | "tf" | "pose" | "info" | "other"
    encoding: string
    count: number
    start: number | null
    end: number | null
}

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

export interface Message {
    key: string
    /** dimos LCM bytes (raw subscriptions) */
    bytes: Uint8Array
    /** the message's recording time, in ms */
    timestamp: number
    seq: number
    /** a cloud ({ positions, intensity, frame }) or a frame ({ kind, width, height, encoding, frame, data }) */
    decoded?: unknown
    /** "low" while scrubbing (thumbnail image, thinned cloud), else "full" */
    quality?: "low" | "full"
}

export interface Topic {
    key: string
    name: string
    type: string
}

type As = "lcm" | "image" | "cloud" | "header"

interface Subscription {
    id: number
    key: string
    stream: string
    as: As
    maxHz: number
    onMessage: (message: Message) => void
}

/** while scrubbing, a playhead that holds still this long gets full-quality frames */
const SETTLE_MS = 350

/** A depth stream by its name (the backend sends those as raw 16UC1 / 32FC1). */
export const isDepthStream = (name: string) => /depth/i.test(name)

export class ReplaySource {
    readonly kind = "replay"
    readonly playhead: TypedStore<Playhead>
    readonly topics: Topic[]
    readonly status = new Store<{ state: ConnectionState; error: string | null }>(
        {
            state: "connecting",
            error: null,
        },
    )
    /** fired when the playhead jumps (a seek, a scrub's end, a loop): layers that accumulate start over */
    readonly onSeek = new Set<() => void>()
    /** the recording changed on disk (a stream edit): the page re-reads it */
    onReload: (() => void) | null = null
    /** the backend's answer time for the last request (ms) */
    rttMs: number | null = null
    readonly #live = zenohSource()
    #ws: WebSocket | null = null
    #subs = new Map<number, Subscription>()
    #stateListeners = new Set<(state: ConnectionState) => void>()
    #nextId = 1
    #seq = 0
    #inFlight: { seq: number; at: number; t: number; mode: Mode } | null = null
    #sent: { t: number; mode: Mode } | null = null
    #lastFrame = 0
    #stillSince = 0
    #lastT = 0
    #wasScrubbing = false
    #raf = 0
    #closed = false

    constructor(
        readonly recordingId: string,
        overview: { start: number; end: number; streams: StreamInfo[] },
        initial?: Partial<Playhead>,
    ) {
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
        this.topics = overview.streams
            .filter((stream) => stream.count > 0)
            .map((stream) => ({
                key: dimosKey(stream.name, stream.type),
                name: "/" + stream.name,
                type: stream.type,
            }))
            .sort((a, b) => a.name.localeCompare(b.name))
        this.playhead.subscribe(() => this.#onPlayhead())
        this.status.subscribe(() => this.#stateListeners.forEach((listener) => listener(this.state)))
    }

    // ── the data source interface (dimos-react's useDataSource) ──

    get state(): ConnectionState {
        return this.status.get().state
    }

    onState(listener: (state: ConnectionState) => void) {
        this.#stateListeners.add(listener)
        return () => this.#stateListeners.delete(listener)
    }

    listTopics(filter = "dimos/**") {
        return Promise.resolve(
            this.topics.filter((topic) => keyMatches(filter, topic.key)),
        )
    }

    /** the playhead in ms: message timestamps are in it */
    now() {
        return this.playhead.get().t * 1000
    }

    subscribeFrontend(
        topic: string,
        callback: (payload: unknown, info: unknown) => void,
        options?: unknown,
    ) {
        return this.#live.subscribeFrontend(topic, callback, options)
    }

    onReconnect(listener: () => void) {
        return this.#live.onReconnect(listener)
    }

    subscribe(
        key: string,
        options: { maxHz?: number; encoding?: string } | undefined,
        onMessage: (message: Message) => void,
    ) {
        const topic = parseKey(key)
        const stream = topic ? topic.name.slice(1) : key
        const heavy = topic &&
            /(Image|CompressedImage|PointCloud2)$/.test(topic.type)
        const encoding = options?.encoding ?? ""
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
            maxHz: options?.maxHz ?? 0,
            onMessage,
        }
        this.#subs.set(sub.id, sub)
        this.#sendSub(sub)
        const off = () => {
            if (!this.#subs.delete(sub.id)) {
                return
            }
            if (this.#ws?.readyState === WebSocket.OPEN) {
                this.#ws.send(JSON.stringify({ op: "unsub", id: sub.id }))
            }
        }
        return Object.assign(off, { unsubscribe: off, update: async () => {} })
    }

    // ── the playback socket ──

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
            this.status.set({ state: "connected", error: null })
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

    #onText(message: { op: string; seq?: number; error?: unknown }) {
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
        const head = this.playhead.get()
        const t = head.t
        // anything but smooth forward playback is a jump; mid-scrub the jump is announced when the scrub ends
        const jumped = t !== this.#lastT &&
            (t < this.#lastT || t - this.#lastT > 1.5 || !head.playing)
        const scrubEnded = this.#wasScrubbing && !head.scrubbing
        this.#wasScrubbing = head.scrubbing
        if ((jumped && !head.scrubbing) || scrubEnded) {
            for (const listener of this.onSeek) {
                listener()
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
                    this.playhead.update({ t: head.end, playing: false })
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

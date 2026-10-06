// Playback over a websocket. The page owns the clock and says where the playhead is (`at`: a time and a mode); for
// every stream it has subscribed to, the backend sends what the playhead crossed or landed on, then `done`. One
// request in flight at a time, so a slow page or a big frame slows the ticks instead of piling up messages.
//
// Modes: `play` sends everything a small stream (tf, poses, info) published since the last tick and the newest
// message of a heavy one (images, clouds), at full quality; `scrub` sends the message at the playhead in low quality
// (thumbnail images, thinned clouds); `pause` is a scrub at full quality (a paused page gets full-res frames).
import {
    cloudPacket,
    decodeCloud,
    decodeImage,
    decodeObject,
    imagePacket,
    LOW_CLOUD_POINTS,
    packet,
    type Quality,
    shrinkImage,
    toLcm,
} from "./payload.ts"
import { encode as lcmEncode, schemas } from "./lcm.ts"
import { atOrBefore, openSource, type Source, type StreamMeta } from "./source.ts"
import type { Thumbs } from "./thumbs.ts"

export type Mode = "play" | "scrub" | "pause"
/** how a subscription wants its messages: dimos LCM bytes, a decoded image, a decoded cloud, or only the header */
export type As = "lcm" | "image" | "cloud" | "header"

/** a jump longer than this (recording seconds) is a seek, not playback */
const MAX_CONTINUOUS_STEP = 1.5
/** a stream whose first message is at most this far ahead of the playhead shows it already (seconds) */
const LEAD_IN = 2
/** most messages of one stream sent in one tick (a long tick at high speed keeps the newest) */
const MAX_PER_TICK = 400
/** seconds of tf before the playhead a jump past the tf index sends meanwhile (short: every chunk it spans is read) */
const TF_RECENT = 0.3

// ── open recordings, shared by every page and endpoint looking at the same file ──

type Open = {
    source: Promise<Source>
    users: number
    timer?: number
    tf: Map<string, TfIndex>
    /** the file it opened (inode, size, mtime): a different file at the same path is opened afresh */
    identity: string
}
const open = new Map<string, Open>()

async function identityOf(path: string): Promise<string> {
    const stat = await Deno.stat(path)
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtime?.getTime()}`
}
const IDLE_CLOSE_MS = 60_000

/** A recording's source, opened once and closed a minute after its last user lets go. */
export async function acquire(
    path: string,
): Promise<
    {
        source: Source
        release: () => void
        tf: (stream: string) => TfIndex
    }
> {
    const identity = await identityOf(path)
    let entry = open.get(path)
    if (entry && entry.identity !== identity) {
        // replaced or changed since it was opened (deleted and copied again, edited by another program): let the old
        // one close when its users are done, and open the file that's there now
        const stale = entry
        open.delete(path)
        if (stale.users === 0) {
            clearTimeout(stale.timer)
            stale.source.then((source) => source.close(), () => {})
        }
        entry = undefined
    }
    if (!entry) {
        entry = { source: openSource(path), users: 0, tf: new Map(), identity }
        open.set(path, entry)
        entry.source.catch(() => open.delete(path))
    }
    const mine = entry
    mine.users++
    clearTimeout(mine.timer)
    const source = await mine.source
    let released = false
    return {
        source,
        release: () => {
            if (released) {
                return
            }
            released = true
            if (--mine.users === 0 && open.get(path) !== mine) {
                source.close() // a replaced file's last user: nothing will open it again
            } else if (mine.users === 0) {
                mine.timer = setTimeout(() => {
                    if (mine.users === 0 && open.get(path) === mine) {
                        open.delete(path)
                        source.close()
                    }
                }, IDLE_CLOSE_MS)
                // an idle recording waiting to close doesn't keep the process alive
                Deno.unrefTimer(mine.timer)
            }
        },
        tf: (stream) => {
            let index = mine.tf.get(stream)
            if (!index) {
                index = TfIndex.start(source, stream)
                mine.tf.set(stream, index)
            }
            return index
        },
    }
}

/** Closes every open recording now (tests; shutting down). */
export async function closeAll() {
    for (const path of [...open.keys()]) {
        clearTimeout(open.get(path)?.timer)
        await closeNow(path)
    }
}

/** Closes a recording now (before an edit rewrites it); its pages are told to reconnect. */
export async function closeNow(path: string) {
    const entry = open.get(path)
    clearTimeout(entry?.timer)
    open.delete(path)
    for (const session of sessions) {
        if (session.path === path) {
            session.reload()
        }
    }
    if (entry) {
        try {
            ;(await entry.source).close()
        } catch {
            // it never opened
        }
    }
}

// ── the tf tree at any time: for every edge, which messages carry it ──

/** a slice of the event loop the tf index reads for before it lets pages' requests in (ms) */
const TF_SLICE_MS = 8
/** background reads (the tf index, scrubbing thumbnails) wait until no page has asked for this long (ms) */
const PAGES_IDLE_MS = 100
/** pages' requests being answered right now, and when the last one was */
let ticking = 0
let lastTick = 0

/** Waits until pages are idle: a background read of a whole file never slows playing or scrubbing. */
export async function afterPages() {
    while (ticking > 0 || performance.now() - lastTick < PAGES_IDLE_MS) {
        await new Promise((resolve) => setTimeout(resolve, PAGES_IDLE_MS / 4))
    }
}

export class TfIndex {
    /** per edge (parent\nchild), the indexes of the messages that set it, ascending */
    edges = new Map<string, number[]>()
    /** messages read so far, from the first: a snapshot at a message before this is the whole tree */
    covered = 0
    /** settles when every message is read (or reading failed: the file closed or changed) */
    done: Promise<void> = Promise.resolve()
    finished = false

    /** Starts reading the stream's messages in the background (a big .mcap's tf means decompressing most of it). */
    static start(source: Source, stream: string): TfIndex {
        const index = new TfIndex()
        index.done = index.#read(source, stream).catch(() => {}).finally(() => index.finished = true)
        return index
    }

    /** Reads every message in order, letting other work in every TF_SLICE_MS (a .db's reads never yield). */
    async #read(source: Source, stream: string) {
        const meta = source.streams.find((s) => s.name === stream)!
        const { times } = await source.index(stream)
        let slice = performance.now()
        for (let i = 0; i < times.length; i++) {
            if (performance.now() - slice > TF_SLICE_MS) {
                await new Promise((resolve) => setTimeout(resolve, 0))
                await afterPages()
                slice = performance.now()
            }
            const message = decodeObject(meta, await source.read(stream, i))
            for (const transform of message?.transforms ?? []) {
                const key = `${transform.header?.frame_id ?? ""}\n${transform.child_frame_id ?? ""}`
                let list = this.edges.get(key)
                if (!list) {
                    list = []
                    this.edges.set(key, list)
                }
                list.push(i)
            }
            this.covered = i + 1
        }
    }

    /** The messages that, applied in order, give the tree as it was at message `at`: each edge's latest. */
    snapshot(at: number): number[] {
        const wanted = new Set<number>()
        for (const list of this.edges.values()) {
            let low = 0, high = list.length - 1, found = -1
            while (low <= high) {
                const middle = (low + high) >> 1
                if (list[middle] <= at) {
                    found = list[middle]
                    low = middle + 1
                } else {
                    high = middle - 1
                }
            }
            if (found >= 0) {
                wanted.add(found)
            }
        }
        return [...wanted].sort((a, b) => a - b)
    }
}

// ── one page's playback ──

type Subscription = {
    id: number
    meta: StreamMeta
    as: As
    maxHz: number
    /** index of the last message sent (-1: none) */
    last: number
    lastQuality: Quality
    lastSentT: number
    /** a tf jump sent before the index reached it: the whole tree follows when the index is read */
    tfPending?: boolean
}

const sessions = new Set<Session>()

export class Session {
    #subs = new Map<number, Subscription>()
    #t = 0
    #mode: Mode = "pause"
    #pending: { t: number; mode: Mode; seq: number } | null = null
    #busy = false
    #closed = false
    /** the page's playhead, for GET api/replay/{id} */
    state = { t: 0, mode: "pause" as Mode, speed: 1 }

    constructor(
        readonly path: string,
        readonly source: Source,
        readonly tf: (stream: string) => TfIndex,
        readonly thumbs: Thumbs | null,
        readonly send: (data: Uint8Array | string) => void,
    ) {
        sessions.add(this)
    }

    close() {
        this.#closed = true
        sessions.delete(this)
    }

    /** the file is about to change: the page reconnects (and re-reads the stream list) */
    reload() {
        // the file is about to be rewritten under this session: it stops reading it, the page reconnects
        this.#closed = true
        this.#subs.clear()
        this.send(JSON.stringify({ op: "reload" }))
    }

    onText(text: string) {
        let message: { op?: string; [key: string]: unknown }
        try {
            message = JSON.parse(text)
        } catch {
            return
        }
        if (message.op === "sub") {
            const meta = this.source.streams.find((s) => s.name === message.stream)
            if (!meta) {
                this.send(
                    JSON.stringify({
                        op: "error",
                        id: message.id,
                        error: `no stream ${message.stream}`,
                    }),
                )
                return
            }
            const sub: Subscription = {
                id: Number(message.id),
                meta,
                as: (["lcm", "image", "cloud", "header"].includes(String(message.as)) ? message.as : "lcm") as As,
                maxHz: Number(message.maxHz) || 0,
                last: -1,
                lastQuality: "low",
                lastSentT: -Infinity,
            }
            this.#subs.set(sub.id, sub)
            if (meta.kind === "tf" && sub.as === "lcm") {
                this.tf(meta.name) // its index starts reading now, so a jump later finds it ready
            }
            // a new subscriber gets what's at the playhead now, like a live topic's latest sample
            this.#request({
                t: this.#t,
                mode: this.#mode === "play" ? "pause" : this.#mode,
                seq: -1,
                only: sub.id,
            })
        } else if (message.op === "unsub") {
            this.#subs.delete(Number(message.id))
        } else if (message.op === "at") {
            const mode = (["play", "scrub", "pause"].includes(String(message.mode)) ? message.mode : "pause") as Mode
            this.state = {
                t: Number(message.t) || 0,
                mode,
                speed: Number(message.speed) || this.state.speed,
            }
            this.#request({
                t: Number(message.t) || 0,
                mode,
                seq: Number(message.seq) || 0,
            })
        }
    }

    #queue: { t: number; mode: Mode; seq: number; only?: number }[] = []

    #request(request: { t: number; mode: Mode; seq: number; only?: number }) {
        if (request.only !== undefined) {
            this.#queue.push(request)
        } else {
            // only the newest playhead matters: an older one still waiting is answered as done
            if (this.#pending) {
                this.send(
                    JSON.stringify({ op: "done", seq: this.#pending.seq, skipped: true }),
                )
            }
            this.#pending = request
        }
        this.#pump()
    }

    async #pump() {
        if (this.#busy) {
            return
        }
        this.#busy = true
        try {
            while (!this.#closed) {
                const next = this.#queue.shift() ?? this.#pending
                if (!next) {
                    break
                }
                if (next === this.#pending) {
                    this.#pending = null
                }
                ticking++
                try {
                    await this.#tick(next.t, next.mode, (next as { only?: number }).only)
                } finally {
                    ticking--
                    lastTick = performance.now()
                }
                if (next.seq >= 0) {
                    this.send(JSON.stringify({ op: "done", seq: next.seq }))
                }
            }
        } catch (error) {
            this.send(
                JSON.stringify({
                    op: "error",
                    error: error instanceof Error ? error.message : String(error),
                }),
            )
        } finally {
            this.#busy = false
        }
    }

    async #tick(t: number, mode: Mode, only?: number) {
        const previousT = this.#t
        const continuous = only === undefined && mode === "play" &&
            this.#mode === "play" && t >= previousT &&
            t - previousT <= MAX_CONTINUOUS_STEP
        if (only === undefined) {
            this.#t = t
            this.#mode = mode
        }
        const quality: Quality = mode === "scrub" ? "low" : "full"
        for (const sub of [...this.#subs.values()]) {
            if (only === undefined && this.#pending) {
                return // a newer playhead is waiting: the rest of this one is out of date
            }
            if (this.#closed || (only !== undefined && sub.id !== only)) {
                continue
            }
            if (!this.#subs.has(sub.id)) {
                continue // unsubscribed meanwhile
            }
            const { times } = await this.source.index(sub.meta.name)
            let at = atOrBefore(times, t)
            const fresh = only !== undefined
            // just before a stream's first message (the opening moment): show that first message, not nothing
            if (at < 0 && times.length && times[0] - t <= LEAD_IN) {
                at = 0
            }
            if (at < 0) {
                sub.last = -1
                continue
            }
            const small = sub.as === "lcm" &&
                (sub.meta.kind === "tf" || sub.meta.kind === "pose" ||
                    sub.meta.kind === "info" ||
                    sub.meta.kind === "other")
            if (
                sub.meta.kind === "tf" && sub.as === "lcm" && (!continuous || fresh)
            ) {
                // a jump: the whole tree as it was at t (each edge's latest message), not just the last message
                if (at !== sub.last || fresh) {
                    const index = this.tf(sub.meta.name)
                    const wanted = new Set(index.snapshot(at))
                    if (at >= index.covered) {
                        // not read that far yet: the last moment's tf now (never wait for the index), the tree when it's in
                        const from = Math.max(
                            atOrBefore(times, times[at] - TF_RECENT) + 1,
                            at - MAX_PER_TICK + 1,
                        )
                        for (let i = from; i <= at; i++) {
                            wanted.add(i)
                        }
                        if (!index.finished) {
                            this.#treeWhenRead(sub, index)
                        }
                    }
                    for (const i of [...wanted].sort((a, b) => a - b)) {
                        await this.#send(sub, i, times[i], quality)
                    }
                    sub.last = at
                }
                continue
            }
            if (continuous && small && at > sub.last && sub.last >= 0) {
                const from = Math.max(sub.last + 1, at - MAX_PER_TICK + 1)
                for (let i = from; i <= at; i++) {
                    await this.#send(sub, i, times[i], quality)
                }
                sub.last = at
                continue
            }
            const upgrade = quality === "full" && sub.lastQuality === "low"
            if (at === sub.last && !upgrade && !fresh) {
                continue
            }
            if (
                continuous && sub.maxHz > 0 &&
                times[at] - sub.lastSentT < 1 / sub.maxHz && !upgrade
            ) {
                continue
            }
            await this.#send(sub, at, times[at], quality)
            sub.last = at
        }
    }

    /** Once the tf index is read, sends the whole tree at the playhead (the page may be paused and ask nothing more). */
    #treeWhenRead(sub: Subscription, index: TfIndex) {
        if (sub.tfPending) {
            return
        }
        sub.tfPending = true
        index.done.then(() => {
            sub.tfPending = false
            if (this.#closed || this.#subs.get(sub.id) !== sub) {
                return
            }
            this.#request({
                t: this.#t,
                mode: this.#mode === "play" ? "pause" : this.#mode,
                seq: -1,
                only: sub.id,
            })
        })
    }

    async #send(sub: Subscription, i: number, t: number, quality: Quality) {
        const header = { s: sub.id, t, i, q: quality }
        sub.lastQuality = quality
        sub.lastSentT = t
        if (sub.as === "image") {
            if (quality === "low" && this.thumbs) {
                const thumb = await this.thumbs.near(sub.meta.name, t)
                if (thumb) {
                    this.send(imagePacket(header, thumb))
                    return
                }
            }
            const image = decodeImage(
                sub.meta,
                await this.source.read(sub.meta.name, i),
            )
            if (!image) {
                return
            }
            const shrunk = quality === "low" ? shrinkImage(image) : image
            // an encoded frame with no thumbnail yet is sent as it is: it's still the right frame
            this.send(
                imagePacket(
                    { ...header, q: shrunk === image ? "full" : "low" },
                    shrunk,
                ),
            )
            if (shrunk === image) {
                sub.lastQuality = "full"
            }
            return
        }
        if (sub.as === "cloud") {
            const cloud = decodeCloud(
                sub.meta,
                await this.source.read(sub.meta.name, i),
                quality === "low" ? LOW_CLOUD_POINTS : Infinity,
            )
            if (cloud) {
                this.send(cloudPacket(header, cloud))
            }
            return
        }
        if (sub.as === "header") {
            const message = decodeObject(
                sub.meta,
                await this.source.read(sub.meta.name, i),
            )
            if (message && schemas[sub.meta.type]) {
                const frame = message.header?.frame_id ?? ""
                this.send(
                    packet(
                        { ...header, k: "lcm" },
                        lcmEncode(sub.meta.type, { header: { frame_id: frame } }),
                    ),
                )
            }
            return
        }
        const bytes = toLcm(sub.meta, await this.source.read(sub.meta.name, i))
        if (bytes) {
            this.send(packet({ ...header, k: "lcm" }, bytes))
        }
    }
}

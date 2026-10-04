// The Replayer's backend (its page is the `#/replay/<id>` view): playback over a websocket (player.ts), the overview
// and per-stream timeline the page draws, single frames / messages / the odometry path for the agent, remote control
// of open players, and stream rename / delete / duplicate as in-place edits of the recording (edit_db.ts,
// edit_mcap.ts). Every action the page has is one of these endpoints.
import { join } from "node:path"
import { HttpError, publishEvent, type Route } from "../http.ts"
import { NotFound, type Recording } from "../recordings/library.ts"
import type { Services } from "../recordings/routes.ts"
import { ffmpeg } from "../recordings/thumbnails.ts"
import { editDb, STREAM_NAME } from "./edit_db.ts"
import { editMcap } from "./edit_mcap.ts"
import { bytesPerPixel, decodeImage, decodeObject, type ImageFrame } from "./payload.ts"
import { acquire, closeNow, Session } from "./player.ts"
import { atOrBefore, type Source } from "./source.ts"
import { Thumbs } from "./thumbs.ts"

const ID = {
    id: {
        type: "string",
        required: true,
        description: "recording id: its path inside the recordings folder",
    },
}
const STREAM = {
    type: "string",
    required: true,
    description: "stream (topic) name",
}

export function replayRoutes({ library }: Services): Route[] {
    const find = async (id: string): Promise<Recording> => {
        let recording: Recording
        try {
            recording = await library.get(id)
        } catch (error) {
            throw error instanceof NotFound ? new HttpError(404, error.message) : error
        }
        if (recording.format === "rrd") {
            throw new HttpError(400, "an .rrd plays in Rerun, not here")
        }
        return recording
    }
    const thumbsByPath = new Map<string, Thumbs>()
    const thumbsFor = (recording: Recording, source: Source) => {
        let thumbs = thumbsByPath.get(recording.path)
        if (!thumbs || thumbs.source !== source) {
            thumbs?.stop()
            const key = `${recording.format}-${recording.size}-${Math.round(recording.modified)}`
            thumbs = new Thumbs(join(library.config.dataDir, "replay", key), source)
            thumbsByPath.set(recording.path, thumbs)
        }
        thumbs.start()
        return thumbs
    }
    const sessionsById = new Map<string, Set<Session>>()
    /** a short-lived look at a recording (endpoints other than the websocket) */
    const withSource = async <T>(
        recording: Recording,
        use: (source: Source) => Promise<T>,
    ): Promise<T> => {
        const opened = await acquire(recording.path)
        try {
            return await use(opened.source)
        } finally {
            opened.release()
        }
    }
    const streamOf = (source: Source, name: string) => {
        const meta = source.streams.find((s) => s.name === name)
        if (!meta) {
            throw new HttpError(
                404,
                `no stream ${name} (streams: ${source.streams.map((s) => s.name).join(", ")})`,
            )
        }
        return meta
    }
    const edit = async (
        recording: Recording,
        stream: string,
        op: "rename" | "delete" | "duplicate",
        to?: string,
    ) => {
        if (recording.symlink) {
            throw new HttpError(
                409,
                `${recording.name} is a link to a file outside the recordings folder; duplicate the recording to edit a copy`,
            )
        }
        if (op !== "delete" && !to) {
            throw new HttpError(400, "name is required")
        }
        // pages playing it let go of the file (and reconnect after); a running thumbnail track stops
        thumbsByPath.get(recording.path)?.stop()
        thumbsByPath.delete(recording.path)
        await closeNow(recording.path)
        const started = performance.now()
        let result: Record<string, unknown>
        try {
            if (recording.format === "db") {
                result = editDb(
                    recording.path,
                    op === "delete" ? { op, stream } : { op, stream, to: to! },
                )
            } else {
                result = await editMcap(
                    recording.path,
                    op === "delete" ? { op, topic: stream } : { op, topic: stream, to: to! },
                )
            }
        } catch (error) {
            throw new HttpError(
                400,
                error instanceof Error ? error.message : String(error),
            )
        }
        library.emit({
            type: "recordings",
            reason: `stream-${op}`,
            id: recording.id,
        })
        publishEvent({ type: "replay", action: "reload", id: recording.id })
        return {
            ok: true,
            op,
            stream,
            ...(to ? { to } : {}),
            seconds: (performance.now() - started) / 1000,
            ...result,
        }
    }

    return [
        {
            method: "GET",
            path: "api/replay/{id}",
            description:
                "The Replayer's view of a recording: start/end, every stream (type, kind: image | cloud | tf | pose | info | " +
                "other, count, first/last time), scrubbing-thumbnail progress, and the playhead of each page playing it",
            params: ID,
            handler: async ({ id }) => {
                const recording = await find(String(id))
                return await withSource(recording, async (source) => {
                    const streams = []
                    let start = Infinity, end = -Infinity
                    for (const meta of source.streams) {
                        const { times } = await source.index(meta.name)
                        const first = times.length ? times[0] : null
                        const last = times.length ? times[times.length - 1] : null
                        if (first !== null && last !== null) {
                            start = Math.min(start, first)
                            end = Math.max(end, last)
                        }
                        streams.push({
                            name: meta.name,
                            type: meta.type,
                            kind: meta.kind,
                            encoding: meta.encoding,
                            count: times.length,
                            start: first,
                            end: last,
                        })
                    }
                    return {
                        id: recording.id,
                        name: recording.name,
                        format: recording.format,
                        size: recording.size,
                        editable: !recording.symlink,
                        start: Number.isFinite(start) ? start : 0,
                        end: Number.isFinite(end) ? end : 0,
                        streams,
                        thumbnails: thumbsByPath.get(recording.path)?.progress ?? {},
                        players: [...(sessionsById.get(recording.id) ?? [])].map((
                            session,
                        ) => session.state),
                    }
                })
            },
        },
        {
            method: "GET",
            path: "api/replay/{id}/timeline",
            description:
                "Per-stream message density for the timeline rows: the recording's span cut into `bins` equal slices and " +
                "each stream's message count per slice (ticks), plus its exact times when it has at most `exact` messages",
            params: {
                ...ID,
                bins: { type: "number", description: "slices (default 1200)" },
                exact: {
                    type: "number",
                    description:
                        "send exact times for streams with at most this many messages in the window (default 2000)",
                },
                from: {
                    type: "number",
                    description: "window start (recording time, seconds; default: the start)",
                },
                to: {
                    type: "number",
                    description: "window end (recording time, seconds; default: the end)",
                },
            },
            handler: async ({ id, bins, exact, from, to }) => {
                const recording = await find(String(id))
                const slices = Math.max(10, Math.min(5000, Number(bins) || 1200))
                const exactUpTo = Math.max(0, Math.min(20000, Number(exact ?? 2000)))
                return await withSource(recording, async (source) => {
                    const all = await Promise.all(
                        source.streams.map(async (meta) => ({
                            meta,
                            times: (await source.index(meta.name)).times,
                        })),
                    )
                    const firsts = all.filter((s) => s.times.length).map((s) => s.times[0])
                    const lasts = all.filter((s) => s.times.length).map((s) => s.times[s.times.length - 1])
                    const start = firsts.length ? Math.min(...firsts) : 0
                    const end = lasts.length ? Math.max(...lasts) : 0
                    const windowFrom = Number.isFinite(Number(from)) && from !== undefined ? Number(from) : start
                    const windowTo = Number.isFinite(Number(to)) && to !== undefined ? Number(to) : end
                    const span = Math.max(1e-9, windowTo - windowFrom)
                    return {
                        start,
                        end,
                        from: windowFrom,
                        to: windowTo,
                        bins: slices,
                        streams: all.map(({ meta, times }) => {
                            const counts = new Array(slices).fill(0)
                            const first = Math.max(0, atOrBefore(times, windowFrom))
                            let last = first
                            for (
                                let i = first;
                                i < times.length && times[i] <= windowTo;
                                i++
                            ) {
                                if (times[i] >= windowFrom) {
                                    counts[
                                        Math.min(
                                            slices - 1,
                                            Math.floor(((times[i] - windowFrom) / span) * slices),
                                        )
                                    ]++
                                }
                                last = i
                            }
                            const inWindow = times.length ? last - first + 1 : 0
                            return {
                                name: meta.name,
                                kind: meta.kind,
                                count: times.length,
                                counts,
                                ...(inWindow <= exactUpTo
                                    ? { times: Array.from(times.subarray(first, last + 1)) }
                                    : {}),
                            }
                        }),
                    }
                })
            },
        },
        {
            method: "GET",
            path: "api/replay/{id}/ws",
            description:
                "The playback stream (a websocket the page opens): it sends {op:sub, id, stream, as: lcm | image | cloud | " +
                "header} and {op:at, t, mode: play | scrub | pause, seq}; the backend answers with what each stream has at " +
                "the playhead (binary: u32 header length, JSON header, payload) and {op:done, seq}",
            params: ID,
            handler: async ({ id }, request) => {
                if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
                    throw new HttpError(426, "open this as a websocket")
                }
                const recording = await find(String(id))
                const opened = await acquire(recording.path)
                const { socket, response } = Deno.upgradeWebSocket(request)
                socket.binaryType = "arraybuffer"
                const send = (data: Uint8Array | string) => {
                    if (socket.readyState === WebSocket.OPEN) {
                        socket.send(data as Uint8Array<ArrayBuffer> | string)
                    }
                }
                const session = new Session(
                    recording.path,
                    opened.source,
                    opened.tf,
                    thumbsFor(recording, opened.source),
                    send,
                )
                const set = sessionsById.get(recording.id) ?? new Set()
                set.add(session)
                sessionsById.set(recording.id, set)
                socket.onmessage = (event) => {
                    if (typeof event.data === "string") {
                        session.onText(event.data)
                    }
                }
                socket.onclose = () => {
                    session.close()
                    set.delete(session)
                    opened.release()
                }
                return response
            },
        },
        {
            method: "POST",
            path: "api/replay/{id}/control",
            role: "context",
            description:
                "Drive the Replayer pages showing this recording: action = play | pause | seek (t: seconds since the " +
                "recording's start) | speed (speed: 0.25..8)",
            params: {
                ...ID,
                action: {
                    type: "string",
                    required: true,
                    description: "play | pause | seek | speed",
                },
                t: { type: "number", description: "seek: seconds since the start" },
                speed: { type: "number", description: "speed: playback rate" },
            },
            handler: async ({ id, action, t, speed }) => {
                const recording = await find(String(id))
                if (!["play", "pause", "seek", "speed"].includes(String(action))) {
                    throw new HttpError(400, "action must be play, pause, seek or speed")
                }
                const players = sessionsById.get(recording.id)?.size ?? 0
                publishEvent({
                    type: "replay",
                    action,
                    id: recording.id,
                    t: t === undefined ? undefined : Number(t),
                    speed: speed === undefined ? undefined : Number(speed),
                })
                return { ok: true, players }
            },
        },
        {
            method: "GET",
            path: "api/replay/{id}/frame",
            description:
                "One camera frame as an image (jpeg, or png for raw pixels): the stream's message at or before time t " +
                "(seconds since the start; default the first frame); without a stream, the main camera (color first)",
            params: {
                ...ID,
                stream: { type: "string", description: "image stream (default: the main camera)" },
                t: {
                    type: "number",
                    description: "seconds since the start (default 0)",
                },
            },
            handler: async ({ id, stream, t }) => {
                const recording = await find(String(id))
                return await withSource(recording, async (source) => {
                    const images = source.streams.filter((s) => s.kind === "image" && s.count > 0)
                    const main = images.find((s) => !/depth|gray|grey|mono|infra/i.test(s.name)) ?? images[0]
                    if (!stream && !main) {
                        throw new HttpError(404, "this recording has no camera")
                    }
                    const meta = stream ? streamOf(source, String(stream)) : main!
                    if (meta.kind !== "image") {
                        throw new HttpError(
                            400,
                            `${meta.name} is a ${meta.type}, not an image stream`,
                        )
                    }
                    const { times } = await source.index(meta.name)
                    if (!times.length) {
                        throw new HttpError(404, `${meta.name} has no messages`)
                    }
                    const start = await recordingStart(source)
                    const i = Math.max(0, atOrBefore(times, start + (Number(t) || 0)))
                    const image = decodeImage(meta, await source.read(meta.name, i))
                    if (!image) {
                        throw new HttpError(500, "couldn't read that frame")
                    }
                    const encoded = await encodeImage(image)
                    return new Response(encoded.data as Uint8Array<ArrayBuffer>, {
                        headers: {
                            "content-type": encoded.type,
                            "x-message-time": String(times[i]),
                        },
                    })
                })
            },
        },
        {
            method: "GET",
            path: "api/replay/{id}/message",
            description:
                "One stream's message at or before time t (seconds since the start), decoded to JSON (long arrays " +
                "shortened): what the player shows for that stream at that moment",
            params: {
                ...ID,
                stream: STREAM,
                t: {
                    type: "number",
                    description: "seconds since the start (default 0)",
                },
            },
            handler: async ({ id, stream, t }) => {
                const recording = await find(String(id))
                return await withSource(recording, async (source) => {
                    const meta = streamOf(source, String(stream))
                    const { times } = await source.index(meta.name)
                    const start = await recordingStart(source)
                    const i = atOrBefore(times, start + (Number(t) || 0))
                    if (i < 0) {
                        return {
                            stream: meta.name,
                            type: meta.type,
                            message: null,
                            note: "no message yet at that time",
                        }
                    }
                    const message = decodeObject(meta, await source.read(meta.name, i))
                    return {
                        stream: meta.name,
                        type: meta.type,
                        index: i,
                        time: times[i],
                        offset: times[i] - start,
                        message: shorten(message),
                    }
                })
            },
        },
        {
            method: "GET",
            path: "api/replay/{id}/path",
            description:
                "The whole route of a pose stream (nav_msgs Odometry / PoseStamped): up to maxPoints [t, x, y, z] in its " +
                "frame (what the player draws as the odometry path)",
            params: {
                ...ID,
                stream: STREAM,
                maxPoints: {
                    type: "number",
                    description: "most points (default 4000)",
                },
            },
            handler: async ({ id, stream, maxPoints }) => {
                const recording = await find(String(id))
                return await withSource(recording, async (source) => {
                    const meta = streamOf(source, String(stream))
                    if (meta.kind !== "pose") {
                        throw new HttpError(
                            400,
                            `${meta.name} is a ${meta.type}, not a pose stream`,
                        )
                    }
                    const { times } = await source.index(meta.name)
                    const most = Math.max(2, Math.min(50000, Number(maxPoints) || 4000))
                    const step = Math.max(1, Math.ceil(times.length / most))
                    const points: number[][] = []
                    let frame = ""
                    for (let i = 0; i < times.length; i += step) {
                        const message = decodeObject(meta, await source.read(meta.name, i))
                        const pose = message?.pose?.pose ?? message?.pose
                        const p = pose?.position
                        if (p) {
                            frame ||= message?.header?.frame_id ?? ""
                            points.push([times[i], p.x, p.y, p.z])
                        }
                    }
                    return { stream: meta.name, frame, points }
                })
            },
        },
        {
            method: "POST",
            path: "api/recordings/{id}/streams/{stream}/rename",
            description:
                "Rename a stream inside the recording, in place (a .db: ALTER TABLE; an .mcap: the chunk with its channel " +
                "record and the summary rewritten into a temp file beside it, then renamed over it). Players reload",
            params: {
                ...ID,
                stream: STREAM,
                name: { type: "string", required: true, description: "the new name" },
            },
            handler: async ({ id, stream, name }) =>
                await edit(
                    await find(String(id)),
                    String(stream),
                    "rename",
                    String(name).trim(),
                ),
        },
        {
            method: "DELETE",
            path: "api/recordings/{id}/streams/{stream}",
            description:
                "Delete a stream and all its messages from the recording, in place (permanent; the page asks first). Players reload",
            params: { ...ID, stream: STREAM },
            handler: async ({ id, stream }) => await edit(await find(String(id)), String(stream), "delete"),
        },
        {
            method: "POST",
            path: "api/recordings/{id}/streams/{stream}/duplicate",
            description:
                'Copy a stream inside the same recording under a new name (default "<stream>_copy"), in place. Players reload',
            params: {
                ...ID,
                stream: STREAM,
                name: {
                    type: "string",
                    description: 'the copy\'s name (default "<stream>_copy")',
                },
            },
            handler: async ({ id, stream, name }) => {
                const recording = await find(String(id))
                let to = name ? String(name).trim() : ""
                if (!to) {
                    const names = await withSource(
                        recording,
                        (source) => Promise.resolve(source.streams.map((s) => s.name)),
                    )
                    const base = `${String(stream).replace(/[^A-Za-z0-9_]/g, "_")}_copy`
                    to = base
                    for (let n = 2; names.includes(to); n++) {
                        to = `${base}${n}`
                    }
                }
                if (recording.format === "db" && !STREAM_NAME.test(to)) {
                    throw new HttpError(
                        400,
                        `"${to}" isn't a usable stream name (letters, digits and _)`,
                    )
                }
                return await edit(recording, String(stream), "duplicate", to)
            },
        },
    ]
}

async function recordingStart(source: Source): Promise<number> {
    let start = Infinity
    for (const meta of source.streams) {
        const { times } = await source.index(meta.name)
        if (times.length) {
            start = Math.min(start, times[0])
        }
    }
    return Number.isFinite(start) ? start : 0
}

// deno-lint-ignore no-explicit-any
function shorten(value: any, depth = 0): any {
    if (value instanceof Uint8Array || value instanceof Int8Array) {
        return value.length > 32 ? `<${value.length} bytes>` : Array.from(value)
    }
    if (ArrayBuffer.isView(value)) {
        const list = Array.from(value as unknown as ArrayLike<number>)
        return list.length > 32 ? [...list.slice(0, 32), `… ${list.length} values`] : list
    }
    if (Array.isArray(value)) {
        const list = value.slice(0, 32).map((item) => shorten(item, depth + 1))
        return value.length > 32 ? [...list, `… ${value.length} items`] : list
    }
    if (typeof value === "bigint") {
        return Number(value)
    }
    if (value && typeof value === "object" && depth < 12) {
        return Object.fromEntries(
            Object.entries(value).map((
                [key, item],
            ) => [key, shorten(item, depth + 1)]),
        )
    }
    return value
}

const PIX_FMT: Record<string, string> = {
    mono8: "gray",
    "8uc1": "gray",
    rgb8: "rgb24",
    bgr8: "bgr24",
    rgba8: "rgba",
    bgra8: "bgra",
    "16UC1": "gray16le",
}

/** An encoded frame as it is; raw pixels → png through ffmpeg. */
async function encodeImage(
    image: ImageFrame,
): Promise<{ data: Uint8Array; type: string }> {
    if (["jpeg", "png", "webp"].includes(image.encoding)) {
        return { data: image.data, type: `image/${image.encoding}` }
    }
    const format = PIX_FMT[image.encoding]
    if (!format || !ffmpeg() || !bytesPerPixel(image.encoding)) {
        throw new HttpError(
            415,
            `can't make an image of ${image.encoding} pixels here`,
        )
    }
    const child = new Deno.Command(ffmpeg()!, {
        args: [
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "rawvideo",
            "-pix_fmt",
            format,
            "-s",
            `${image.width}x${image.height}`,
            "-i",
            "pipe:0",
            "-frames:v",
            "1",
            "-f",
            "image2pipe",
            "-c:v",
            "png",
            "pipe:1",
        ],
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
    }).spawn()
    const writer = child.stdin.getWriter()
    await writer.write(
        image.data.subarray(
            0,
            image.width * image.height * bytesPerPixel(image.encoding),
        ),
    )
    await writer.close()
    const { stdout, success, stderr } = await child.output()
    if (!success) {
        throw new HttpError(
            500,
            `ffmpeg: ${new TextDecoder().decode(stderr).trim()}`,
        )
    }
    return { data: stdout, type: "image/png" }
}

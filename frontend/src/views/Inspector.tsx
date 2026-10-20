// The selected recording, right of the list: its actions (Replay first; the rest in ⋯ on a narrow pane) and name, a
// big preview that cycles its camera streams and its odometry path from above, the facts with its notes under them,
// and Streams (with each stream's coverage over time) / TF frames / Warnings tabs.
import { type ReactNode, useEffect, useRef, useState } from "react"
import {
    Alert,
    Badge,
    Button,
    Chip,
    IconButton,
    KeyValue,
    Menu,
    Progress,
    Segmented,
    Table,
    Tabs,
    Text,
    TextArea,
    Tree,
    useMediaQuery,
} from "dimos-react"
import {
    api,
    bytes,
    duration,
    gap,
    type Inspection,
    type Job,
    type Recording,
    type TfTree,
    type Upload,
    type Warning,
} from "../api.ts"
import { type Overview, replayApi, type Timeline } from "../replay/api.ts"
import { metres, Thumbnail } from "./Thumbnail.tsx"

/** A dimos-react Menu item. */
export type MenuItem =
    | {
        label: string
        icon?: string
        title?: string
        shortcut?: string
        disabled?: boolean
        danger?: boolean
        checked?: boolean
        onSelect: () => void
    }
    | "-"
    | { heading: string }

export type InspectorActions = {
    replay: () => void
    rename: () => void
    upload: () => void
    /** upload it again as name.vN (in ⋯ via `more`; a button too once it changed since its upload) */
    reupload: () => void
    remove: () => void
    /** Open with: the targets the recording can open in */
    opens: MenuItem[]
    /** what's always in ⋯ (duplicate, convert, copy path, show in folder) */
    more: MenuItem[]
}

/** what Upload reads as: idle, or where its upload is (a percentage only when real byte counts arrive) */
export function uploadLabel(
    upload: Upload | undefined,
    waitingForLogin: boolean,
): string {
    if (
        !upload || upload.state === "done" || upload.state === "failed" ||
        upload.state === "cancelled"
    ) {
        return "Upload"
    }
    if (upload.state === "queued") {
        return waitingForLogin ? "Waiting for login" : "Queued…"
    }
    const known = upload.bytesTotal > 0 && upload.bytesDone > 0
    return known ? `Uploading ${Math.floor((upload.bytesDone / upload.bytesTotal) * 100)}%` : "Uploading…"
}

/** The recording's sensors, by kind, as chips: "3× cam", "lidar", "2× odom", "imu", "tf". */
function sensorChips(overview: Overview | null): string[] {
    if (!overview) {
        return []
    }
    const count = (test: (s: Overview["streams"][number]) => boolean) => overview.streams.filter(test).length
    const kinds: [string, number][] = [
        ["cam", count((s) => s.kind === "image" && !/camera_?info/i.test(s.name))],
        ["lidar", count((s) => s.kind === "cloud")],
        ["odom", count((s) => s.kind === "pose")],
        ["imu", count((s) => /imu/i.test(s.type) || /(^|\/|_)imu/i.test(s.name))],
        ["tf", count((s) => s.kind === "tf")],
    ]
    return kinds.filter(([, n]) => n > 0).map((
        [label, n],
    ) => (n > 1 && label !== "tf" ? `${n}× ${label}` : label))
}

type View = { kind: "camera"; stream: string; hz: number } | {
    kind: "path"
    stream: string
}

/** the cameras (the preview's own camera first) and, when there's a pose stream, the path from above */
function viewsOf(
    overview: Overview | null,
    inspection: Inspection | null,
    recording: Recording,
): View[] {
    const rate = (name: string) => inspection?.streams.find((s) => s.name === name)?.hz ?? 0
    const main = recording.thumbnail.state === "ready" ? recording.thumbnail.stream : null
    const cameras = (overview?.streams ?? [])
        .filter((s) => s.kind === "image" && s.count > 0)
        .sort((a, b) =>
            Number(b.name === main) - Number(a.name === main) ||
            a.name.localeCompare(b.name)
        )
        .map((s): View => ({ kind: "camera", stream: s.name, hz: rate(s.name) }))
    const poses = (overview?.streams ?? []).filter((s) => s.kind === "pose" && s.count > 1)
    const thumb = recording.thumbnail
    const pathStream = thumb.state === "path" && poses.some((s) => s.name === thumb.stream)
        ? thumb.stream
        : [...poses].sort((a, b) =>
            Number(/odom|path|pose/i.test(b.name)) -
                Number(/odom|path|pose/i.test(a.name)) || b.count - a.count
        )[0]?.name
    return pathStream ? [...cameras, { kind: "path", stream: pathStream }] : cameras
}

// routes already read this session (each read decodes a few hundred messages: seconds on a big file)
const routes = new Map<string, Promise<[number, number][]>>()

/** The whole route from above, equal aspect, start dot and end ring, with its extent. */
function PathView({ id, stream }: { id: string; stream: string }) {
    const [points, setPoints] = useState<[number, number][] | null>(null)
    const [error, setError] = useState<string | null>(null)
    useEffect(() => {
        let live = true
        setPoints(null)
        setError(null)
        const key = `${id}\n${stream}`
        if (!routes.has(key)) {
            routes.set(
                key,
                replayApi.path(id, stream, 400).then((path) => path.points.map(([, x, y]) => [x, y])),
            )
        }
        routes.get(key)!.then(
            (route) => live && setPoints(route),
            (e) => {
                routes.delete(key)
                live && setError(String(e.message ?? e))
            },
        )
        return () => {
            live = false
        }
    }, [id, stream])
    if (error || !points || points.length < 2) {
        return (
            <Text small muted mono className="rec-preview-note">
                {error ??
                    (!points ? `reading ${stream}'s route…` : `${stream} has no positions`)}
            </Text>
        )
    }
    const xs = points.map((p) => p[0])
    const ys = points.map((p) => p[1])
    const [minX, maxX, minY, maxY] = [
        Math.min(...xs),
        Math.max(...xs),
        Math.min(...ys),
        Math.max(...ys),
    ]
    const extent = Math.max(maxX - minX, maxY - minY, 0.01)
    const [w, h, pad] = [320, 180, 14]
    const scale = (Math.min(w, h) - 2 * pad) / extent
    const [cx, cy] = [(minX + maxX) / 2, (minY + maxY) / 2]
    const at = ([x, y]: [number, number]) => [w / 2 + (x - cx) * scale, h / 2 - (y - cy) * scale] as const
    const line = points.map((p, i) => `${i ? "L" : "M"}${at(p).map((v) => v.toFixed(1)).join(" ")}`).join("")
    const [sx, sy] = at(points[0])
    const [ex, ey] = at(points[points.length - 1])
    let length = 0
    for (let i = 1; i < points.length; i++) {
        length += Math.hypot(
            points[i][0] - points[i - 1][0],
            points[i][1] - points[i - 1][1],
        )
    }
    return (
        <>
            <svg
                viewBox={`0 0 ${w} ${h}`}
                preserveAspectRatio="xMidYMid meet"
                aria-label={`${stream} from above`}
            >
                <path d={line} className="rec-path-line" />
                <circle cx={sx} cy={sy} r="3.6" className="rec-path-start" />
                <circle cx={ex} cy={ey} r="4" className="rec-path-end" />
            </svg>
            <Badge className="rec-preview-tag">
                {stream} · top-down · {metres(length)} of path, {metres(extent)} across
            </Badge>
        </>
    )
}

/** Another camera than the preview's: one real frame at the hovered time (the middle until hovered). */
function CameraFrame(
    { id, stream, hz, span }: {
        id: string
        stream: string
        hz: number
        span: number
    },
) {
    const [t, setT] = useState(span / 2)
    const [shown, setShown] = useState(span / 2)
    const [failed, setFailed] = useState(false)
    useEffect(() => {
        setT(span / 2)
        setShown(span / 2)
        setFailed(false)
    }, [id, stream, span])
    // a frame per pause in the pointer, not per pixel moved: each one is a read from the file
    useEffect(() => {
        const timer = setTimeout(() => setShown(t), 140)
        return () => clearTimeout(timer)
    }, [t])
    return (
        <div
            className="rec-camera-frame"
            onPointerMove={(event) => {
                const rect = event.currentTarget.getBoundingClientRect()
                setT(
                    Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) *
                        span,
                )
            }}
        >
            {failed
                ? (
                    <Text small muted mono className="rec-preview-note">
                        no frame from {stream} here
                    </Text>
                )
                : (
                    <img
                        src={replayApi.frameUrl(id, stream, shown)}
                        alt={`${stream} at ${shown.toFixed(1)} s`}
                        onError={() => setFailed(true)}
                        onLoad={() => setFailed(false)}
                    />
                )}
            <span
                className="rec-thumb-bar"
                style={{ width: `${span ? (t / span) * 100 : 0}%` }}
            />
            <Badge className="rec-preview-tag">
                {stream}
                {hz ? ` · ${hz.toFixed(1)} Hz` : ""}
            </Badge>
        </div>
    )
}

function Preview({ recording, overview, inspection, version, span }: {
    recording: Recording
    overview: Overview | null
    inspection: Inspection | null
    version: number
    span: number
}) {
    const views = viewsOf(overview, inspection, recording)
    const [index, setIndex] = useState(0)
    useEffect(() => setIndex(0), [recording.id])
    const view = views[Math.min(index, Math.max(0, views.length - 1))]
    const step = (by: number) => views.length && setIndex((i) => (i + by + views.length) % views.length)
    const clock = (fraction: number) =>
        new Date((recording.recorded + span * fraction) * 1000).toLocaleTimeString(
            [],
            {
                hour: "numeric",
                minute: "2-digit",
                second: "2-digit",
            },
        )
    const thumb = recording.thumbnail
    let body: ReactNode
    if (!view) {
        body = (
            <Text small muted mono className="rec-preview-note">
                {overview ? "no camera or pose stream to show" : thumb.state === "pending" ? "preview…" : "reading…"}
            </Text>
        )
    } else if (view.kind === "path") {
        body = <PathView id={recording.id} stream={view.stream} />
    } else if (thumb.state === "ready" && thumb.stream === view.stream) {
        body = (
            <>
                <Thumbnail id={recording.id} thumb={thumb} version={version} />
                <Badge className="rec-preview-tag">
                    {view.stream}
                    {view.hz ? ` · ${view.hz.toFixed(1)} Hz` : ""} · start, middle, end
                </Badge>
            </>
        )
    } else {
        body = (
            <CameraFrame
                id={recording.id}
                stream={view.stream}
                hz={view.hz}
                span={span}
            />
        )
    }
    return (
        <div className="rec-preview-col">
            <div
                className="rec-film"
                tabIndex={0}
                aria-label="Preview; the arrow keys switch view"
                data-testid="preview"
                data-view={view ? `${view.kind}:${view.stream}` : ""}
                onKeyDown={(event) => {
                    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                        event.preventDefault()
                        step(event.key === "ArrowRight" ? 1 : -1)
                    }
                }}
            >
                {body}
            </div>
            {span > 0 && (
                <div className="rec-ticks">
                    <Text small muted mono>{clock(0)}</Text>
                    <Text small muted mono>{clock(0.5)}</Text>
                    <Text small muted mono>{clock(1)}</Text>
                </div>
            )}
            {views.length > 0 && (
                <div className="rec-row-flex rec-views">
                    <IconButton
                        icon="chevron-left"
                        size="sm"
                        label="Previous view"
                        onClick={() => step(-1)}
                    />
                    <Segmented
                        size="sm"
                        className="rec-views-strip"
                        label="view"
                        value={view ? `${view.kind}:${view.stream}` : ""}
                        items={views.map((v) => ({
                            value: `${v.kind}:${v.stream}`,
                            icon: v.kind === "camera" ? "camera" : "map",
                            label: v.kind === "camera" ? v.stream : "Odom path",
                        }))}
                        onChange={(value: string) =>
                            setIndex(
                                views.findIndex((v) => `${v.kind}:${v.stream}` === value),
                            )}
                    />
                    <IconButton
                        icon="chevron-right"
                        size="sm"
                        label="Next view"
                        onClick={() => step(1)}
                    />
                </div>
            )}
        </div>
    )
}

/** Each stream's messages over the recording: runs of slices with messages, and where the rate sank (amber). */
function coverage(counts: number[]) {
    const slices = counts.length || 1
    const nonzero = counts.filter((c) => c > 0).sort((a, b) => a - b)
    const median = nonzero.length ? nonzero[Math.floor(nonzero.length / 2)] : 0
    const runs: [number, number][] = []
    const drops: [number, number][] = []
    const push = (list: [number, number][], i: number) => {
        const last = list[list.length - 1]
        if (last && last[1] === i) {
            last[1] = i + 1
        } else {
            list.push([i, i + 1])
        }
    }
    counts.forEach((count, i) => {
        if (count > 0) {
            push(runs, i)
            // a slice well under the stream's usual rate (only meaningful for streams with several per slice)
            if (median >= 4 && count < median * 0.35) {
                push(drops, i)
            }
        }
    })
    const share = ([a, b]: [number, number]) => ({
        left: `${(a / slices) * 100}%`,
        width: `${((b - a) / slices) * 100}%`,
    })
    return { runs: runs.map(share), drops: drops.map(share) }
}

function StreamsPane({ inspection, timeline, warnings }: {
    inspection: Inspection
    timeline: Timeline | null
    warnings: Warning[]
}) {
    const flagged = new Set(warnings.map((w) => w.stream).filter(Boolean))
    type Row = Inspection["streams"][number]
    return (
        <>
            <Table
                compact
                sticky
                data-testid="streams"
                rowKey="name"
                defaultSort={{ key: "name", dir: "asc" }}
                rows={inspection.streams}
                columns={[
                    {
                        key: "name",
                        label: "Topic",
                        render: (s: Row) => (
                            <Text
                                mono
                                small
                                title={`${s.name}: ${s.type} (${s.encoding})`}
                                tone={flagged.has(s.name) ? "warn" : undefined}
                            >
                                {flagged.has(s.name) ? "⚠ " : ""}
                                {s.name}
                            </Text>
                        ),
                    },
                    {
                        key: "type",
                        label: "Type",
                        render: (s: Row) => (
                            <Text small muted title={s.type}>
                                {s.type.split(/[./]/).pop()}
                            </Text>
                        ),
                    },
                    {
                        key: "count",
                        label: "Count",
                        align: "right",
                        render: (s: Row) => <Text mono small>{s.count.toLocaleString()}</Text>,
                    },
                    {
                        key: "hz",
                        label: "Hz",
                        align: "right",
                        render: (s: Row) => <Text mono small>{s.hz > 0 ? s.hz.toFixed(1) : "—"}</Text>,
                    },
                    {
                        key: "maxGap",
                        label: "Max gap",
                        align: "right",
                        render: (s: Row) => <Text mono small>{gap(s.maxGap)}</Text>,
                    },
                    {
                        key: "coverage",
                        label: "Coverage",
                        sort: false,
                        width: "34%",
                        render: (s: Row) => {
                            const row = timeline?.streams.find((t) => t.name === s.name)
                            const cov = row ? coverage(row.counts) : null
                            return cov
                                ? (
                                    <div
                                        className="rec-covbar"
                                        aria-label={`${s.name} over time`}
                                    >
                                        {cov.runs.map((style, i) => <i key={i} style={style} />)}
                                        {cov.drops.map((style, i) => <b key={`d${i}`} style={style} />)}
                                    </div>
                                )
                                : <Progress />
                        },
                    },
                ]}
            />
            <div className="rec-row-flex rec-legend">
                <Text small muted>
                    <i className="rec-lg-msg" />messages
                </Text>
                <Text small muted>
                    <i className="rec-lg-gap" />gap
                </Text>
                <Text small muted>
                    <i className="rec-lg-drop" />rate drop
                </Text>
                {!timeline && <Text small muted>reading coverage…</Text>}
            </div>
        </>
    )
}

const rate = (
    hz: number,
) => (hz >= 10 ? `${Math.round(hz)} Hz` : `${hz.toFixed(1)} Hz`)
/** +m:ss after the recording's start */
function offset(seconds: number): string {
    const s = Math.max(0, Math.round(seconds))
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const ss = String(s % 60).padStart(2, "0")
    return h ? `+${h}:${String(m).padStart(2, "0")}:${ss}` : `+${m}:${ss}`
}

/** The tf frames as a tree, each child with its transform's rate (or static) and, when it stops early, when. */
function TfPane(
    { tf, start, warnings }: {
        tf: TfTree
        start: number | null
        warnings: Warning[]
    },
) {
    if (!tf.source) {
        return <Text small muted>No tf stream.</Text>
    }
    if (!tf.edges.length) {
        return <Text small muted>No frames in {tf.source}.</Text>
    }
    const children = new Map<string, TfTree["edges"]>()
    for (const edge of tf.edges) {
        children.set(edge.parent, [...(children.get(edge.parent) ?? []), edge])
    }
    const conflicted = new Set(tf.conflicts.map((c) => c.frame))
    const flagged = new Set(
        warnings.filter((w) => w.message.startsWith("TF:") && w.frame).map((w) => w.frame!),
    )
    const end = Math.max(...tf.edges.map((edge) => edge.last))
    type Node = {
        id: string
        label: ReactNode
        badge?: ReactNode
        children?: Node[]
    }
    const meta = (edge: TfTree["edges"][number]) => {
        if (edge.static) {
            return "static"
        }
        const parts = [edge.hz > 0 ? rate(edge.hz) : `${edge.count}×`]
        if (
            start !== null &&
            end - edge.last > Math.max(1, edge.hz > 0 ? 10 / edge.hz : 1)
        ) {
            parts.push(`until ${offset(edge.last - start)}`)
        }
        return parts.join(" · ")
    }
    const node = (
        frame: string,
        edge: TfTree["edges"][number] | null,
        path: Set<string>,
    ): Node => {
        const bad = conflicted.has(frame) || flagged.has(frame)
        const kids = path.has(frame) ? [] : (children.get(frame) ?? []).sort((a, b) => a.child.localeCompare(b.child))
        const next = new Set(path).add(frame)
        return {
            id: [...next].join("/"),
            label: (
                <Text mono small tone={bad ? "warn" : undefined}>
                    {frame}
                    {conflicted.has(frame) ? " (2 parents)" : ""}
                </Text>
            ),
            badge: edge ? <Text mono small muted>{meta(edge)}</Text> : undefined,
            children: kids.length ? kids.map((kid) => node(kid.child, kid, next)) : undefined,
        }
    }
    const roots = tf.roots.length ? tf.roots : [tf.edges[0].parent]
    const frames = new Set(tf.edges.flatMap((edge) => [edge.parent, edge.child])).size
    return (
        <>
            <Text small muted mono as="p">
                {tf.source} · {frames} frames · {tf.messages.toLocaleString()} {tf.messages === 1 ? "msg" : "msgs"}
                {tf.coverage && tf.coverage !== "all of it" ? ` · read ${tf.coverage}` : ""}
            </Text>
            <div data-testid="tf-tree">
                <Tree
                    nodes={roots.map((root) => node(root, null, new Set()))}
                    defaultExpanded="all"
                />
            </div>
            {tf.conflicts.map((c) => (
                <Text key={c.frame} small mono tone="warn" as="p">
                    {c.frame} ← {c.parents.map((p) => `${p.parent} (${p.count})`).join(" | ")}
                </Text>
            ))}
        </>
    )
}

function WarningList(
    { warnings, limit }: { warnings: Warning[]; limit?: number },
) {
    if (!warnings.length) {
        return (
            <Alert tone="ok" title="Nothing to flag" data-testid="no-issues">
                no gaps, rate drops or tf problems found
            </Alert>
        )
    }
    return (
        <div className="rec-warnings" data-testid="warnings">
            {warnings.slice(0, limit ?? warnings.length).map((w, i) => (
                <Alert key={i} tone="warn" title={w.message} data-kind={w.kind}>
                    <Text mono small>{w.detail}</Text>
                </Alert>
            ))}
        </div>
    )
}

type Tab = "streams" | "tf" | "warnings"

export function Inspector(
    { recording, actions, upload, waitingForLogin, jobs, version, onBack }: {
        recording: Recording
        actions: InspectorActions
        upload: Upload | undefined
        waitingForLogin: boolean
        jobs: Job[]
        version: number
        onBack: () => void
    },
) {
    const [inspection, setInspection] = useState<Inspection | null>(null)
    const [overview, setOverview] = useState<Overview | null>(null)
    const [timeline, setTimeline] = useState<Timeline | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [tab, setTab] = useState<Tab>("streams")
    const [note, setNote] = useState(recording.note)
    const [saved, setSaved] = useState<"saved" | "saving…" | null>(null)
    const noteTimer = useRef<number | undefined>(undefined)
    const narrow = useMediaQuery("(max-width: 1100px)")
    const phone = useMediaQuery("(max-width: 760px)")

    useEffect(() => {
        let live = true
        setInspection(null)
        setOverview(null)
        setTimeline(null)
        setError(null)
        setNote(recording.note)
        setSaved(null)
        api.get(recording.id).then(
            (full) => live && setInspection(full.inspection),
            (e) => live && setError(String(e.message ?? e)),
        )
        // the stream kinds (the preview's cameras and pose streams), then their coverage: both read the file's index
        replayApi.overview(recording.id).then((o) => {
            if (!live) {
                return
            }
            setOverview(o)
            replayApi.timeline(recording.id, 160).then(
                (t) => live && setTimeline(t),
                () => {},
            )
        }, () => {})
        return () => {
            live = false
        }
    }, [recording.id, recording.modified])
    useEffect(() => {
        if (!saved) {
            setNote(recording.note)
        }
    }, [recording.note])

    const saveNote = (text: string) => {
        clearTimeout(noteTimer.current)
        setSaved("saving…")
        noteTimer.current = setTimeout(() => {
            api.setNote(recording.id, text).then(
                () => setSaved("saved"),
                (e) => setError(String(e.message ?? e)),
            )
        }, 500)
    }

    const busy = upload?.state === "queued" || upload?.state === "uploading"
    const link = upload?.state === "done" ? upload.link : recording.uploaded?.link
    const warnings = inspection?.warnings ?? []
    // the list's row trails a fresh inspection by a refresh: the inspection's own numbers win
    const span = Math.max(0, recording.duration ?? inspection?.duration ?? 0)
    const summary = recording.error ?? inspection?.error ?? recording.summary ??
        inspection?.summary ?? null
    const chips = sensorChips(overview)
    const running = jobs.filter((j) => j.recording === recording.id && j.state === "running")
    const uploadAction = link && !busy
        ? {
            label: "View upload",
            icon: "external",
            onSelect: () => globalThis.open(link, "_blank", "noreferrer"),
        }
        : {
            label: uploadLabel(upload, waitingForLogin),
            icon: "upload",
            onSelect: actions.upload,
        }
    const changedSince = !busy && recording.uploaded?.changed ? recording.uploaded : null
    // a narrow pane folds Rename / Upload / Delete / Open with into ⋯ (Replay stays)
    const folded: MenuItem[] = narrow
        ? [
            { label: "Rename", icon: "edit", onSelect: actions.rename },
            uploadAction,
            {
                label: "Delete",
                icon: "trash",
                danger: true,
                onSelect: actions.remove,
            },
            ...(actions.opens.length ? ["-" as const, { heading: "Open with" }, ...actions.opens] : []),
            "-",
        ]
        : []

    return (
        <section
            className="rec-detail"
            aria-label={recording.name}
            data-testid="inspector"
        >
            <header className="rec-detail-head">
                <div className="rec-who">
                    {phone && (
                        <IconButton
                            icon="arrow-left"
                            label="All recordings"
                            onClick={onBack}
                        />
                    )}
                    <div className="rec-who-text">
                        <Text
                            className="rec-name"
                            mono
                            data-testid="recording-name"
                            title={recording.path}
                        >
                            {recording.name}
                        </Text>
                        <div className="rec-row-flex">
                            <Text small muted>
                                {recording.error || inspection?.error ? "unreadable" : summary ?? "reading…"}
                            </Text>
                            <Badge>.{recording.format}</Badge>
                            {recording.symlink && <Badge title="a symlink to a file elsewhere">link</Badge>}
                        </div>
                        {changedSince && (
                            <Text small muted data-testid="changed-since-upload">
                                changed since it went up as {changedSince.name}
                                {changedSince.changes.length ? `: ${changedSince.changes.slice(0, 3).join(", ")}` : ""}
                                {changedSince.changes.length > 3 ? `, and ${changedSince.changes.length - 3} more` : ""}
                            </Text>
                        )}
                    </div>
                </div>
                <div className="rec-row-flex rec-acts">
                    <Button
                        variant="primary"
                        icon="play"
                        size="sm"
                        data-testid="action-replay"
                        onClick={actions.replay}
                    >
                        Replay
                    </Button>
                    {!narrow && (
                        <>
                            <Button
                                size="sm"
                                icon="edit"
                                data-testid="action-rename"
                                onClick={actions.rename}
                            >
                                Rename
                            </Button>
                            <Button
                                size="sm"
                                icon={uploadAction.icon}
                                loading={busy}
                                data-testid="action-upload"
                                onClick={uploadAction.onSelect}
                            >
                                {uploadAction.label}
                            </Button>
                            {changedSince && (
                                <Button
                                    size="sm"
                                    icon="upload"
                                    data-testid="action-reupload"
                                    title={changedSince.changes.join("\n") || undefined}
                                    onClick={actions.reupload}
                                >
                                    Re-upload as {changedSince.nextName}
                                </Button>
                            )}
                            <Button
                                size="sm"
                                variant="danger"
                                icon="trash"
                                data-testid="action-delete"
                                onClick={actions.remove}
                            >
                                Delete
                            </Button>
                            {actions.opens.length > 0 && (
                                <Menu
                                    placement="bottom-end"
                                    items={actions.opens}
                                    trigger={
                                        <Button
                                            size="sm"
                                            iconRight="chevron-down"
                                            data-testid="action-open"
                                        >
                                            Open with
                                        </Button>
                                    }
                                />
                            )}
                        </>
                    )}
                    <Menu
                        placement="bottom-end"
                        items={[...folded, ...actions.more]}
                        trigger={
                            <IconButton
                                icon="more-horizontal"
                                size="sm"
                                label="More actions"
                                data-testid="action-more"
                            />
                        }
                    />
                </div>
            </header>
            {running.map((job) => (
                <div className="rec-row-flex rec-job" key={job.id}>
                    <Text small muted>converting → .{job.to}</Text>
                    <Progress value={job.progress || undefined} className="rec-grow" />
                    <Text small muted>{job.phase}</Text>
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => api.cancelJob(job.id)}
                    >
                        Cancel
                    </Button>
                </div>
            ))}
            <div className="rec-hero">
                <Preview
                    recording={recording}
                    overview={overview}
                    inspection={inspection}
                    version={version}
                    span={span}
                />
                <div className="rec-facts">
                    <KeyValue
                        items={[
                            [
                                "Duration",
                                span ? duration(span) : duration(recording.duration),
                            ],
                            ["Size", bytes(recording.size)],
                            [
                                "Recorded",
                                <span
                                    key="r"
                                    title={recording.recordedFrom === "mtime"
                                        ? "the file's time (no timestamps inside)"
                                        : "its first message"}
                                >
                                    {new Date(recording.recorded * 1000).toLocaleString([], {
                                        month: "short",
                                        day: "numeric",
                                        year: "numeric",
                                        hour: "numeric",
                                        minute: "2-digit",
                                    })}
                                </span>,
                            ],
                            [
                                "Messages",
                                (inspection?.messages ?? recording.messages)
                                    ?.toLocaleString() ?? "…",
                            ],
                            [
                                "Sensors",
                                <span key="s" className="rec-row-flex">
                                    {chips.length ? chips.map((c) => <Chip key={c}>{c}</Chip>) : "…"}
                                </span>,
                            ],
                            ...(recording.rrds.length
                                ? [
                                    [
                                        "Rerun files",
                                        recording.rrds.map((r) => r.name).join(", "),
                                    ] as const,
                                ]
                                : []),
                        ]}
                    />
                    <div className="rec-notes">
                        <div className="rec-row-flex">
                            <Text className="rec-group-label">Notes</Text>
                            <Text small muted>
                                {saved ?? "kept in the app, not the file"}
                            </Text>
                        </div>
                        <TextArea
                            rows={3}
                            placeholder="What's in this recording?"
                            value={note}
                            data-testid="notes"
                            onChange={(text: string) => {
                                setNote(text)
                                saveNote(text)
                            }}
                        />
                    </div>
                    {!inspection ? <Text small muted>{error ?? "reading…"}</Text> : warnings.length
                        ? (
                            <>
                                <WarningList warnings={warnings} limit={2} />
                                {warnings.length > 2 && (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        iconRight="arrow-right"
                                        onClick={() => setTab("warnings")}
                                    >
                                        All {warnings.length} warnings
                                    </Button>
                                )}
                            </>
                        )
                        : (
                            <Alert tone="ok" title="Healthy">
                                no gaps, rate drops or tf problems found
                            </Alert>
                        )}
                </div>
            </div>
            <Tabs
                value={tab}
                onChange={setTab}
                items={[
                    {
                        value: "streams",
                        label: "Streams",
                        badge: inspection?.streams.length,
                    },
                    {
                        value: "tf",
                        label: "TF frames",
                        badge: inspection?.tf.edges.length,
                    },
                    {
                        value: "warnings",
                        label: "Warnings",
                        badge: inspection ? warnings.length : undefined,
                    },
                ]}
            />
            <div className="rec-pane">
                {!inspection ? <Text small muted>{error ?? "reading…"}</Text> : tab === "streams"
                    ? (
                        <StreamsPane
                            inspection={inspection}
                            timeline={timeline}
                            warnings={warnings}
                        />
                    )
                    : tab === "tf"
                    ? (
                        <TfPane
                            tf={inspection.tf}
                            start={inspection.start}
                            warnings={warnings}
                        />
                    )
                    : <WarningList warnings={warnings} />}
            </div>
        </section>
    )
}

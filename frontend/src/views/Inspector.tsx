// The selected recording, right of the list: its actions (Replay first; the rest fold into ⋯ as the pane narrows) and
// name, a big preview that cycles its camera streams and its odometry path from above, the facts with its notes under
// them, and Streams (with each stream's coverage over time) / TF frames / Warnings tabs.
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react"
import {
    api,
    bytes,
    duration,
    gap,
    type Inspection,
    type Job,
    type Recording,
    type Upload,
    type Warning,
} from "../api.ts"
import { type Overview, replayApi, type Timeline } from "../replay/api.ts"
import { FloatMenu, type MenuItem, Thumbnail } from "../ui.tsx"
import { Tree } from "./SummaryPanel.tsx"

export type InspectorActions = {
    replay: () => void
    rename: () => void
    upload: () => void
    remove: () => void
    /** Open with: the targets the recording can open in */
    opens: MenuItem[]
    /** what's always in ⋯ (duplicate, convert, copy path, show in folder) */
    more: MenuItem[]
}

/** what Upload reads as: idle, or where its upload is (a percentage only when real byte counts arrive) */
export function uploadLabel(upload: Upload | undefined, waitingForLogin: boolean): string {
    if (!upload || upload.state === "done" || upload.state === "failed" || upload.state === "cancelled") {
        return "Upload"
    }
    if (upload.state === "queued") {
        return waitingForLogin ? "Waiting for login" : "Queued…"
    }
    const known = upload.bytesTotal > 0 && upload.bytesDone > 0
    return known ? `Uploading ${Math.floor((upload.bytesDone / upload.bytesTotal) * 100)}%` : "Uploading…"
}

type Action = { id: string; label: string; className?: string; keep?: boolean; run: () => void; menu?: MenuItem[] }

/** The header's buttons, left to right; when they don't fit, the last ones go into ⋯ first (Replay never does). */
function Actions({ actions, extra, room }: { actions: Action[]; extra: MenuItem[]; room: number }) {
    const box = useRef<HTMLDivElement>(null)
    const [hidden, setHidden] = useState<string[]>([])
    const [menu, setMenu] = useState<{ anchor: HTMLElement; items: MenuItem[] } | null>(null)
    useLayoutEffect(() => {
        const el = box.current
        if (!el) {
            return
        }
        const buttons = [...el.querySelectorAll<HTMLElement>("[data-action]")]
        buttons.forEach((b) => (b.hidden = false))
        const gone: string[] = []
        for (const action of [...actions].reverse()) {
            if (el.scrollWidth <= room + 1 || action.keep) {
                break
            }
            const button = buttons.find((b) => b.dataset.action === action.id)
            if (button) {
                button.hidden = true
                gone.push(action.id)
            }
        }
        setHidden((current) => current.join() === gone.join() ? current : gone)
    }, [room, actions.map((a) => a.label).join()])
    const overflow = (): MenuItem[] => {
        const folded = actions.filter((a) => hidden.includes(a.id))
        const items: MenuItem[] = []
        for (const action of folded.filter((a) => !a.menu)) {
            items.push({
                label: action.label.replace(/^▶ /, ""),
                danger: action.className?.includes("delete"),
                onSelect: action.run,
            })
        }
        for (const action of folded.filter((a) => a.menu)) {
            items.push({ heading: action.label.replace(/ ▾$/, "") }, ...action.menu!)
        }
        return items
    }
    return (
        <div className="acts" ref={box} style={{ maxWidth: room }}>
            {actions.map((action) => (
                <button
                    key={action.id}
                    type="button"
                    data-action={action.id}
                    className={`dim-btn sm ${action.className ?? ""}`}
                    aria-haspopup={action.menu ? "menu" : undefined}
                    data-testid={`action-${action.id}`}
                    onClick={(event) =>
                        action.menu ? setMenu({ anchor: event.currentTarget, items: action.menu }) : action.run()}
                >
                    {action.label}
                </button>
            ))}
            <button
                type="button"
                className="dim-btn sm icon"
                aria-label="More actions"
                aria-haspopup="menu"
                data-testid="action-more"
                onClick={(event) => {
                    const folded = overflow()
                    setMenu({
                        anchor: event.currentTarget,
                        items: [
                            ...folded,
                            ...(folded.length && extra.length ? [{ separator: true } as const] : []),
                            ...extra,
                        ],
                    })
                }}
            >
                ⋯
            </button>
            {menu && <FloatMenu at={{ anchor: menu.anchor }} items={menu.items} onClose={() => setMenu(null)} />}
        </div>
    )
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
    return kinds.filter(([, n]) => n > 0).map(([label, n]) => (n > 1 && label !== "tf" ? `${n}× ${label}` : label))
}

type View = { kind: "camera"; stream: string; hz: number } | { kind: "path"; stream: string }

/** the cameras (the preview's own camera first) and, when there's a pose stream, the path from above */
function viewsOf(overview: Overview | null, inspection: Inspection | null, recording: Recording): View[] {
    const rate = (name: string) => inspection?.streams.find((s) => s.name === name)?.hz ?? 0
    const main = recording.thumbnail.state === "ready" ? recording.thumbnail.stream : null
    const cameras = (overview?.streams ?? [])
        .filter((s) => s.kind === "image" && s.count > 0)
        .sort((a, b) => Number(b.name === main) - Number(a.name === main) || a.name.localeCompare(b.name))
        .map((s): View => ({ kind: "camera", stream: s.name, hz: rate(s.name) }))
    const poses = (overview?.streams ?? []).filter((s) => s.kind === "pose" && s.count > 1)
    const thumb = recording.thumbnail
    const pathStream = thumb.state === "path" && poses.some((s) => s.name === thumb.stream)
        ? thumb.stream
        : [...poses].sort((a, b) =>
            Number(/odom|path|pose/i.test(b.name)) - Number(/odom|path|pose/i.test(a.name)) || b.count - a.count
        )[0]?.name
    return pathStream ? [...cameras, { kind: "path", stream: pathStream }] : cameras
}

/** "12 m", "1.4 km" */
const metres = (value: number) =>
    value >= 1000 ? `${(value / 1000).toFixed(1)} km` : `${value < 10 ? value.toFixed(1) : Math.round(value)} m`

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
            routes.set(key, replayApi.path(id, stream, 400).then((path) => path.points.map(([, x, y]) => [x, y])))
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
    if (error) {
        return <div className="preview-note muted mono">{error}</div>
    }
    if (!points) {
        return <div className="preview-note muted mono">reading {stream}'s route…</div>
    }
    if (points.length < 2) {
        return <div className="preview-note muted mono">{stream} has no positions</div>
    }
    const xs = points.map((p) => p[0])
    const ys = points.map((p) => p[1])
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
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
        length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
    }
    return (
        <>
            <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet" aria-label={`${stream} from above`}>
                <path d={line} className="path-line" />
                <circle cx={sx} cy={sy} r="3.6" className="path-start" />
                <circle cx={ex} cy={ey} r="4" className="path-end" />
            </svg>
            <span className="tag">
                {stream} · top-down · {metres(length)} of path, {metres(extent)} across
            </span>
        </>
    )
}

/** Another camera than the preview's: one real frame at the hovered time (the middle until hovered). */
function CameraFrame({ id, stream, hz, span }: { id: string; stream: string; hz: number; span: number }) {
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
            className="camera-frame"
            onPointerMove={(event) => {
                const rect = event.currentTarget.getBoundingClientRect()
                setT(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * span)
            }}
        >
            {failed ? <div className="preview-note muted mono">no frame from {stream} here</div> : (
                <img
                    src={replayApi.frameUrl(id, stream, shown)}
                    alt={`${stream} at ${shown.toFixed(1)} s`}
                    onError={() => setFailed(true)}
                    onLoad={() => setFailed(false)}
                />
            )}
            <span className="thumb-bar" style={{ width: `${span ? (t / span) * 100 : 0}%` }} />
            <span className="tag">{stream}{hz ? ` · ${hz.toFixed(1)} Hz` : ""}</span>
        </div>
    )
}

function Preview(
    { recording, overview, inspection, version, span }: {
        recording: Recording
        overview: Overview | null
        inspection: Inspection | null
        version: number
        span: number
    },
) {
    const views = viewsOf(overview, inspection, recording)
    const [index, setIndex] = useState(0)
    const strip = useRef<HTMLDivElement>(null)
    useEffect(() => setIndex(0), [recording.id])
    const view = views[Math.min(index, Math.max(0, views.length - 1))]
    const step = (by: number) => views.length && setIndex((i) => (i + by + views.length) % views.length)
    useEffect(() => {
        strip.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" })
    }, [index])
    const clock = (fraction: number) =>
        new Date((recording.recorded + span * fraction) * 1000).toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit",
            second: "2-digit",
        })
    const thumb = recording.thumbnail
    let body: ReactNode
    if (!view) {
        body = (
            <div className="preview-note muted mono">
                {overview ? "no camera or pose stream to show" : thumb.state === "pending" ? "preview…" : "reading…"}
            </div>
        )
    } else if (view.kind === "path") {
        body = <PathView id={recording.id} stream={view.stream} />
    } else if (thumb.state === "ready" && thumb.stream === view.stream) {
        body = (
            <>
                <Thumbnail id={recording.id} thumb={thumb} version={version} />
                <span className="tag">
                    {view.stream}
                    {view.hz ? ` · ${view.hz.toFixed(1)} Hz` : ""} · start, middle, end
                </span>
            </>
        )
    } else {
        body = <CameraFrame id={recording.id} stream={view.stream} hz={view.hz} span={span} />
    }
    return (
        <div className="preview-col">
            <div
                className="film big"
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
                <div className="ticks mono">
                    <span>{clock(0)}</span>
                    <span>{clock(0.5)}</span>
                    <span>{clock(1)}</span>
                </div>
            )}
            {views.length > 0 && (
                <div className="views">
                    <button type="button" className="dim-btn sm" aria-label="Previous view" onClick={() => step(-1)}>
                        ‹
                    </button>
                    <div className="seg" ref={strip} role="group" aria-label="view">
                        {views.map((v, i) => (
                            <button
                                key={`${v.kind}:${v.stream}`}
                                type="button"
                                className="dim-btn sm"
                                aria-pressed={v === view}
                                onClick={() => setIndex(i)}
                            >
                                <span className="k">{v.kind === "camera" ? "CAM" : "MAP"}</span>
                                {v.kind === "camera" ? v.stream : "Odom path"}
                            </button>
                        ))}
                    </div>
                    <button type="button" className="dim-btn sm" aria-label="Next view" onClick={() => step(1)}>
                        ›
                    </button>
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

function StreamsPane(
    { inspection, timeline, warnings }: {
        inspection: Inspection
        timeline: Timeline | null
        warnings: Warning[]
    },
) {
    const flagged = new Set(warnings.map((w) => w.stream).filter(Boolean))
    const rows = [...inspection.streams].sort((a, b) => a.name.localeCompare(b.name))
    return (
        <>
            <div className="scroll">
                <table className="streams-table" data-testid="streams">
                    <thead>
                        <tr>
                            <th>Topic</th>
                            <th className="t-type">Type</th>
                            <th className="num">Count</th>
                            <th className="num">Hz</th>
                            <th className="num">Max gap</th>
                            <th className="cov">Coverage</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((s) => {
                            const row = timeline?.streams.find((t) => t.name === s.name)
                            const cov = row ? coverage(row.counts) : null
                            const bad = flagged.has(s.name)
                            return (
                                <tr key={s.name} className={`${bad ? "flagged" : ""} ${s.count ? "" : "empty-stream"}`}>
                                    <td className="mono topic" title={`${s.name}: ${s.type} (${s.encoding})`}>
                                        {bad && <span aria-label="has a warning">⚠</span>}
                                        {s.name}
                                    </td>
                                    <td className="muted t-type" title={s.type}>{s.type.split(/[./]/).pop()}</td>
                                    <td className="num mono">{s.count.toLocaleString()}</td>
                                    <td className="num mono">{s.hz > 0 ? s.hz.toFixed(1) : "—"}</td>
                                    <td className="num mono">{gap(s.maxGap)}</td>
                                    <td className="cov">
                                        {cov
                                            ? (
                                                <div className="covbar" aria-label={`${s.name} over time`}>
                                                    {cov.runs.map((style, i) => <i key={i} style={style} />)}
                                                    {cov.drops.map((style, i) => <b key={`d${i}`} style={style} />)}
                                                </div>
                                            )
                                            : <div className="covbar loading" />}
                                    </td>
                                </tr>
                            )
                        })}
                    </tbody>
                </table>
            </div>
            <div className="legend small muted">
                <span>
                    <i className="lg-msg" />messages
                </span>
                <span>
                    <i className="lg-gap" />gap
                </span>
                <span>
                    <i className="lg-drop" />rate drop
                </span>
                {!timeline && <span>reading coverage…</span>}
            </div>
        </>
    )
}

function WarningList({ warnings }: { warnings: Warning[] }) {
    if (!warnings.length) {
        return (
            <div className="note ok-note" data-testid="no-issues">
                <b>Nothing to flag</b> <span>no gaps, rate drops or tf problems found</span>
            </div>
        )
    }
    return (
        <div className="warning-list" data-testid="warnings">
            {warnings.map((w, i) => (
                <div key={i} className="note warn-note" data-kind={w.kind}>
                    <b>{w.message}</b> <span className="mono">{w.detail}</span>
                </div>
            ))}
        </div>
    )
}

type Tab = "streams" | "tf" | "warnings"

export function Inspector(
    { recording, actions, upload, waitingForLogin, jobs, version, onBack, renaming, onRenamed, onCancelRename }: {
        recording: Recording
        actions: InspectorActions
        upload: Upload | undefined
        waitingForLogin: boolean
        jobs: Job[]
        version: number
        onBack: () => void
        /** the name is being edited in place */
        renaming: boolean
        onRenamed: (name: string) => void
        onCancelRename: () => void
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
    const head = useRef<HTMLDivElement>(null)
    const who = useRef<HTMLDivElement>(null)
    const nameRef = useRef<HTMLDivElement>(null)
    const [room, setRoom] = useState(600)

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
        replayApi.overview(recording.id).then(
            (o) => {
                if (!live) {
                    return
                }
                setOverview(o)
                replayApi.timeline(recording.id, 160).then((t) => live && setTimeline(t), () => {})
            },
            () => {},
        )
        return () => {
            live = false
        }
    }, [recording.id, recording.modified])
    useEffect(() => {
        if (!saved) {
            setNote(recording.note)
        }
    }, [recording.note])

    // the room the actions get: the header's width less the name's (at least 200 px of it); a phone stacks them
    useLayoutEffect(() => {
        const el = head.current
        if (!el) {
            return
        }
        const fit = () => {
            const style = getComputedStyle(el)
            const inner = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
            const stacked = matchMedia("(max-width: 760px)").matches
            const name = Math.max(200, Math.min(320, who.current?.scrollWidth ?? 200))
            setRoom(Math.max(80, stacked ? inner : inner - 16 - name))
        }
        const observer = new ResizeObserver(fit)
        observer.observe(el)
        fit()
        return () => observer.disconnect()
    }, [])

    // rename in place: the name's text is selected up to its extension
    useEffect(() => {
        const el = nameRef.current
        if (!renaming || !el) {
            return
        }
        el.textContent = recording.name
        el.focus()
        const dot = recording.name.lastIndexOf(".")
        const range = document.createRange()
        range.setStart(el.firstChild ?? el, 0)
        range.setEnd(el.firstChild ?? el, dot > 0 ? dot : recording.name.length)
        getSelection()?.removeAllRanges()
        getSelection()?.addRange(range)
    }, [renaming])
    const finishRename = (keep: boolean) => {
        const text = nameRef.current?.textContent?.trim() ?? ""
        if (keep && text && text !== recording.name) {
            onRenamed(text)
        } else {
            if (nameRef.current) {
                nameRef.current.textContent = recording.name
            }
            onCancelRename()
        }
    }

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
    const list: Action[] = [
        { id: "replay", label: "▶ Replay", className: "primary", keep: true, run: actions.replay },
        { id: "rename", label: "Rename", run: actions.rename },
        link && !busy
            ? { id: "upload", label: "View upload ↗", run: () => globalThis.open(link, "_blank", "noreferrer") }
            : { id: "upload", label: uploadLabel(upload, waitingForLogin), className: "upload", run: actions.upload },
        { id: "delete", label: "Delete", className: "delete", run: actions.remove },
        ...(actions.opens.length ? [{ id: "open", label: "Open with ▾", run: () => {}, menu: actions.opens }] : []),
    ]
    const warnings = inspection?.warnings ?? []
    // the list's row trails a fresh inspection by a refresh: the inspection's own numbers win
    const span = Math.max(0, recording.duration ?? inspection?.duration ?? 0)
    const summary = recording.error ?? inspection?.error ?? recording.summary ?? inspection?.summary ?? null
    const chips = sensorChips(overview)
    const running = jobs.filter((j) => j.recording === recording.id && j.state === "running")

    return (
        <section className="detail" aria-label={`${recording.name}`} data-testid="inspector">
            <div className="dhead" ref={head}>
                <Actions actions={list} extra={actions.more} room={room} />
                <div className="who" ref={who}>
                    <button type="button" className="dim-btn sm ghost back" onClick={onBack}>
                        ← All
                    </button>
                    <div>
                        <div
                            ref={nameRef}
                            className="name mono"
                            data-testid="recording-name"
                            contentEditable={renaming ? "plaintext-only" : false}
                            suppressContentEditableWarning
                            title={recording.path}
                            onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                    event.preventDefault()
                                    finishRename(true)
                                } else if (event.key === "Escape") {
                                    event.preventDefault()
                                    event.stopPropagation()
                                    finishRename(false)
                                }
                            }}
                            onBlur={() => renaming && finishRename(true)}
                        >
                            {recording.name}
                        </div>
                        <div className="sub small">
                            <span>{recording.error || inspection?.error ? "unreadable" : summary ?? "reading…"}</span>
                            <span className="dim-badge">.{recording.format}</span>
                            {recording.symlink && (
                                <span className="dim-badge" title="a symlink to a file elsewhere">link</span>
                            )}
                        </div>
                    </div>
                </div>
            </div>
            {running.map((job) => (
                <div className="job-strip small" key={job.id}>
                    <span className="muted">converting → .{job.to}</span>
                    <div className={`dim-progress ${job.progress ? "" : "indeterminate"}`}>
                        <span style={{ width: `${(job.progress || 0.3) * 100}%` }} />
                    </div>
                    <span className="muted job-phase">{job.phase}</span>
                    <button type="button" className="dim-btn ghost sm" onClick={() => api.cancelJob(job.id)}>
                        Cancel
                    </button>
                </div>
            ))}
            <div className="hero">
                <Preview
                    recording={recording}
                    overview={overview}
                    inspection={inspection}
                    version={version}
                    span={span}
                />
                <div className="facts">
                    <div className="kv">
                        <span>Duration</span>
                        <span>{span ? duration(span) : duration(recording.duration)}</span>
                    </div>
                    <div className="kv">
                        <span>Size</span>
                        <span>{bytes(recording.size)}</span>
                    </div>
                    <div className="kv">
                        <span>Recorded</span>
                        <span
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
                        </span>
                    </div>
                    <div className="kv">
                        <span>Messages</span>
                        <span>{(inspection?.messages ?? recording.messages)?.toLocaleString() ?? "…"}</span>
                    </div>
                    <div className="kv">
                        <span>Sensors</span>
                        <span className="chips">
                            {chips.length ? chips.map((c) => <span key={c} className="dim-chip">{c}</span>) : "…"}
                        </span>
                    </div>
                    {recording.rrds.length > 0 && (
                        <div className="kv">
                            <span>Rerun files</span>
                            <span>{recording.rrds.map((r) => r.name).join(", ")}</span>
                        </div>
                    )}
                    <label className="notes">
                        <span className="lab">
                            <span className="section-head">Notes</span>
                            <small className="muted">{saved ?? "kept in the app, not the file"}</small>
                        </span>
                        <textarea
                            className="dim-textarea"
                            rows={3}
                            placeholder="What's in this recording?"
                            value={note}
                            data-testid="notes"
                            onChange={(event) => {
                                setNote(event.target.value)
                                saveNote(event.target.value)
                            }}
                        />
                    </label>
                    <div className="health">
                        {!inspection ? <span className="muted small">{error ?? "reading…"}</span> : warnings.length
                            ? (
                                <>
                                    {warnings.slice(0, 2).map((w, i) => (
                                        <div key={i} className="note warn-note">
                                            <b>{w.message}</b> <span className="mono">{w.detail}</span>
                                        </div>
                                    ))}
                                    {warnings.length > 2 && (
                                        <button
                                            type="button"
                                            className="dim-btn sm ghost"
                                            onClick={() => setTab("warnings")}
                                        >
                                            All {warnings.length} warnings →
                                        </button>
                                    )}
                                </>
                            )
                            : (
                                <div className="note ok-note">
                                    <b>Healthy</b> <span>no gaps, rate drops or tf problems found</span>
                                </div>
                            )}
                    </div>
                </div>
            </div>
            <div className="tabs" role="tablist">
                {([
                    ["streams", "Streams", inspection?.streams.length],
                    ["tf", "TF frames", inspection?.tf.edges.length],
                    ["warnings", "Warnings", inspection ? warnings.length : undefined],
                ] as const).map(([key, label, n]) => (
                    <button
                        key={key}
                        type="button"
                        role="tab"
                        aria-selected={tab === key}
                        className={tab === key ? "on" : ""}
                        onClick={() => setTab(key)}
                    >
                        {label}
                        {n !== undefined && <span className="n">{n}</span>}
                    </button>
                ))}
            </div>
            <div className="pane">
                {!inspection
                    ? <p className="muted small">{error ?? "reading…"}</p>
                    : tab === "streams"
                    ? <StreamsPane inspection={inspection} timeline={timeline} warnings={warnings} />
                    : tab === "tf"
                    ? <Tree tf={inspection.tf} start={inspection.start} warnings={warnings} />
                    : <WarningList warnings={warnings} />}
            </div>
        </section>
    )
}

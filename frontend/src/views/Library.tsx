// The recordings list: sort, date sections, previews, the Summary panel, Open / actions menus, conversions and
// uploads. Every action is a backend endpoint (api.ts), the same ones Desktop's agent calls.
import { useCallback, useEffect, useRef, useState } from "react"
import {
    api,
    bytes,
    duration,
    type Job,
    type ListResponse,
    type Order,
    type Recording,
    type RrdFile,
    type SortKey,
    type Upload,
    when,
} from "../api.ts"
import { go } from "../App.tsx"
import { ThemeToggle } from "../ThemeToggle.tsx"
import { ConfirmDialog, HoverMenu, type MenuItem, RenameDialog, Thumbnail, toast } from "../ui.tsx"
import { SummaryPanel } from "./SummaryPanel.tsx"
import { UploadTray, useTray } from "./Uploads.tsx"

const SORTS: { key: SortKey; label: string }[] = [
    { key: "date", label: "Date" },
    { key: "size", label: "Size" },
    { key: "duration", label: "Duration" },
]

function saved<T extends string>(key: string, fallback: T): T {
    try {
        return (localStorage.getItem(`dim-recordings.${key}`) as T) ?? fallback
    } catch {
        return fallback
    }
}
function save(key: string, value: string) {
    try {
        localStorage.setItem(`dim-recordings.${key}`, value)
    } catch {
        // private window
    }
}

const fail = (error: unknown) => toast(String((error as Error)?.message ?? error), "danger")

type DialogState =
    | { kind: "rename"; recording: Recording | RrdFile }
    | { kind: "delete"; recording: Recording | RrdFile }
    | null

export function Library() {
    const [sort, setSort] = useState<SortKey>(saved("sort", "date"))
    const [order, setOrder] = useState<Order>(saved("order", "desc"))
    const [data, setData] = useState<ListResponse | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [jobs, setJobs] = useState<Record<string, Job>>({})
    const [dialog, setDialog] = useState<DialogState>(null)
    const [summary, setSummary] = useState<
        { id: string; pinned: boolean } | null
    >(null)
    const [trayOpen, setTrayOpen] = useState(false)
    const [login, setLogin] = useState(false)
    const [thumbVersion, setThumbVersion] = useState(1)
    const hideTimer = useRef<number | undefined>(undefined)
    const { tray, error: trayError, refresh: refreshTray } = useTray()

    const load = useCallback(() => {
        api.list(sort, order).then((d) => {
            setData(d)
            setError(null)
        }, (e) => setError(String(e.message ?? e)))
    }, [sort, order])
    useEffect(load, [load])

    // live: the backend's events (a file appeared, a preview finished, a job moved)
    useEffect(() => {
        let socket: WebSocket | null = null
        let timer: number | undefined
        let closed = false
        const connect = () => {
            socket = new WebSocket(
                new URL(
                    "api/events/ws",
                    location.href.replace(/^http/, "ws").replace(/#.*$/, ""),
                ),
            )
            socket.onmessage = (message) => {
                const event = JSON.parse(message.data)
                if (event.type === "job") {
                    const job = event.job as Job
                    setJobs((current) => ({ ...current, [job.id]: job }))
                    if (job.state === "done") {
                        toast(`${job.phase}`, "ok")
                    } else if (job.state === "failed") {
                        toast(`converting failed: ${job.error}`, "danger")
                    }
                    if (job.state !== "running") {
                        load()
                    }
                    return
                }
                if (event.type === "thumbnail") {
                    setThumbVersion((v) => v + 1)
                }
                clearTimeout(timer)
                timer = setTimeout(load, 250)
            }
            socket.onclose = () => {
                if (!closed) {
                    setTimeout(connect, 2000)
                }
            }
        }
        connect()
        return () => {
            closed = true
            socket?.close()
        }
    }, [load])
    useEffect(() => {
        api.jobs().then(
            ({ jobs }) => setJobs(Object.fromEntries(jobs.map((job) => [job.id, job]))),
            () => {},
        )
    }, [])

    const all = data?.sections.flatMap((s) => s.recordings) ?? []
    const summaryRecording = summary ? all.find((r) => r.id === summary.id) : undefined
    const uploadsByPath = new Map<string, Upload>(
        (tray?.uploads ?? []).map((u) => [u.path, u]),
    )

    const showSummary = (id: string) => {
        clearTimeout(hideTimer.current)
        setSummary((current) => current?.pinned ? current : { id, pinned: false })
    }
    const hideSummary = () => {
        clearTimeout(hideTimer.current)
        hideTimer.current = setTimeout(
            () => setSummary((current) => current?.pinned ? current : null),
            300,
        )
    }

    const open = (recording: Recording | RrdFile, target: string) => {
        if (target === "replayer") {
            go({ view: "replay", id: recording.id })
            return
        }
        api.open(recording.id, target).then(
            (r) => toast(`opened ${r.opened}`, "ok"),
            fail,
        )
    }
    const upload = async (recording: Recording) => {
        try {
            await api.upload(recording.id)
            setTrayOpen(true)
            if (tray && !tray.account.loggedIn) {
                setLogin(true)
            }
            refreshTray()
        } catch (e) {
            fail(e)
        }
    }
    const copyPath = (recording: Recording | RrdFile) => {
        navigator.clipboard.writeText(recording.path).then(
            () => toast("path copied", "ok"),
            () => toast(recording.path, "info"),
        )
    }

    const actions = (recording: Recording): MenuItem[] => [
        {
            label: "Rename…",
            onSelect: () => setDialog({ kind: "rename", recording }),
        },
        {
            label: "Duplicate",
            onSelect: () =>
                api.duplicate(recording.id).then(
                    (r) => toast(`made ${r.id}`, "ok"),
                    fail,
                ),
        },
        { separator: true },
        { heading: "Convert to" },
        ...recording.conversions.map((c) => ({
            label: `.${c.to}`,
            hint: c.ok ? undefined : c.reason,
            disabled: !c.ok ||
                Object.values(jobs).some((j) => j.recording === recording.id && j.state === "running"),
            onSelect: () =>
                api.convert(recording.id, c.to).then(
                    (job) => setJobs((current) => ({ ...current, [job.id]: job })),
                    fail,
                ),
        })),
        { separator: true },
        { label: "Copy path", onSelect: () => copyPath(recording) },
        {
            label: "Show in folder",
            onSelect: () => api.reveal(recording.id).then(() => {}, fail),
        },
        { separator: true },
        {
            label: "Delete…",
            danger: true,
            onSelect: () => setDialog({ kind: "delete", recording }),
        },
    ]

    const openMenu = (recording: Recording | RrdFile, testId: string) => (
        <HoverMenu
            label="Open ▾"
            testId={testId}
            items={recording.opens.map((o) => ({
                label: o.label,
                hint: o.ok ? undefined : o.reason,
                disabled: !o.ok,
                onSelect: () => open(recording, o.target),
            }))}
        />
    )

    const rrdButtons = (rrd: RrdFile) => {
        const target = rrd.opens[0]
        return (
            <div className="row-actions">
                <button
                    type="button"
                    className="dim-btn sm"
                    disabled={!target?.ok}
                    title={target?.reason}
                    onClick={() => open(rrd, "rerun")}
                >
                    Open
                </button>
                <button
                    type="button"
                    className="dim-btn sm ghost delete"
                    onClick={() => setDialog({ kind: "delete", recording: rrd })}
                >
                    Delete
                </button>
            </div>
        )
    }

    const row = (recording: Recording, section: string | null) => {
        const running = Object.values(jobs).filter((j) => j.recording === recording.id && j.state === "running")
        if (recording.format === "rrd") {
            return (
                <div className="row rrd-row" key={recording.id} data-id={recording.id}>
                    <div className="thumb placeholder none rrd-thumb">
                        <span>.rrd</span>
                    </div>
                    <div className="name-cell">
                        <span className="name mono">
                            <span className="name-text">{recording.name}</span>
                        </span>
                        <span className="muted small">rerun recording</span>
                    </div>
                    <div className="mono num">{bytes(recording.size)}</div>
                    <div className="mono num muted">—</div>
                    <div className="mono">{when(recording.recorded, section)}</div>
                    <div className="muted small">—</div>
                    {rrdButtons(recording as unknown as RrdFile)}
                </div>
            )
        }
        const liveUpload = uploadsByPath.get(recording.path)
        const link = liveUpload?.state === "done" ? liveUpload.link : recording.uploaded?.link
        return (
            <div
                className={`row ${summary?.id === recording.id ? "active" : ""}`}
                key={recording.id}
                data-id={recording.id}
            >
                <Thumbnail
                    id={recording.id}
                    thumb={recording.thumbnail}
                    version={thumbVersion}
                />
                <div className="name-cell">
                    <span className="name mono" title={recording.path}>
                        <span className="name-text">{recording.name}</span>
                        {recording.symlink && (
                            <span className="dim-badge" title="a symlink to a file elsewhere">
                                link
                            </span>
                        )}
                    </span>
                    {recording.note && (
                        <span className="note-line small">
                            {recording.note.split("\n")[0]}
                        </span>
                    )}
                    {running.map((job) => (
                        <div className="job" key={job.id}>
                            <span className="small muted">→ .{job.to}</span>
                            <div
                                className={`dim-progress ${job.progress ? "" : "indeterminate"}`}
                            >
                                <span style={{ width: `${(job.progress || 0.3) * 100}%` }} />
                            </div>
                            <span className="small muted job-phase" title={job.phase}>
                                {job.phase}
                            </span>
                            <button
                                type="button"
                                className="dim-btn ghost sm"
                                onClick={() => api.cancelJob(job.id)}
                            >
                                ✕
                            </button>
                        </div>
                    ))}
                    {recording.rrds.map((rrd) => (
                        <div className="rrd" key={rrd.id} data-id={rrd.id}>
                            <span className="mono small">↳ {rrd.name}</span>
                            <span className="mono small muted">{bytes(rrd.size)}</span>
                            {rrdButtons(rrd)}
                        </div>
                    ))}
                </div>
                <div className="mono num">{bytes(recording.size)}</div>
                <div className="mono num">
                    {recording.inspected ? duration(recording.duration) : "…"}
                </div>
                <div
                    className="mono"
                    title={recording.recordedFrom === "mtime"
                        ? "the file's time (no timestamps inside)"
                        : "its first message"}
                >
                    {when(recording.recorded, section)}
                </div>
                <div className={`small streams-cell ${recording.error ? "error" : ""}`}>
                    {recording.error ? "unreadable" : recording.summary ?? "reading…"}
                </div>
                <div className="row-actions">
                    <button
                        type="button"
                        className={`dim-btn sm ghost ${summary?.id === recording.id ? "on" : ""}`}
                        onMouseEnter={() => showSummary(recording.id)}
                        onMouseLeave={hideSummary}
                        onClick={() => setSummary({ id: recording.id, pinned: true })}
                    >
                        Summary
                    </button>
                    {openMenu(recording, `open-${recording.id}`)}
                    {link
                        ? (
                            <a
                                className="dim-btn sm primary"
                                href={link}
                                target="_blank"
                                rel="noreferrer"
                                title="uploaded: open it in the console"
                            >
                                View ↗
                            </a>
                        )
                        : (
                            <button
                                type="button"
                                className="dim-btn sm"
                                disabled={!!liveUpload &&
                                    (liveUpload.state === "queued" ||
                                        liveUpload.state === "uploading")}
                                onClick={() => upload(recording)}
                            >
                                {liveUpload?.state === "uploading" ||
                                        liveUpload?.state === "queued"
                                    ? "Uploading…"
                                    : "Upload"}
                            </button>
                        )}
                    <HoverMenu
                        label="⋯"
                        items={actions(recording)}
                        testId={`more-${recording.id}`}
                    />
                </div>
            </div>
        )
    }

    const active = (tray?.uploads ?? []).filter((u) => u.state === "queued" || u.state === "uploading").length
    return (
        <div className={`library ${summaryRecording ? "with-summary" : ""}`}>
            <header className="bar">
                <span className="bar-title">Recordings</span>
                <span className="mono muted small dir" title="the recordings folder">
                    {data?.dir}
                </span>
                <div className="spacer" />
                <div className="sorts" role="group" aria-label="sort">
                    {SORTS.map((s) => (
                        <button
                            key={s.key}
                            type="button"
                            className={`dim-btn sm ${sort === s.key ? "primary on" : "ghost"}`}
                            aria-pressed={sort === s.key}
                            onClick={() => {
                                if (sort === s.key) {
                                    const next = order === "desc" ? "asc" : "desc"
                                    setOrder(next)
                                    save("order", next)
                                } else {
                                    setSort(s.key)
                                    save("sort", s.key)
                                }
                            }}
                        >
                            {s.label} {sort === s.key ? (order === "desc" ? "↓" : "↑") : ""}
                        </button>
                    ))}
                </div>
                <button
                    type="button"
                    className={`dim-btn sm ${trayOpen ? "on" : ""}`}
                    onClick={() => setTrayOpen(!trayOpen)}
                >
                    Uploads{active ? ` · ${active}` : ""}
                </button>
                <ThemeToggle />
            </header>
            {error && <p className="error banner">{error}</p>}
            <div className="library-body">
                <div className="table">
                    <div className="row head">
                        <span />
                        <span>name</span>
                        <span className="num">size</span>
                        <span className="num">duration</span>
                        <span>recorded</span>
                        <span>streams</span>
                        <span />
                    </div>
                    {data?.sections.map((section, index) => (
                        <section key={section.label ?? index} className="group">
                            {section.label && <h2 className="group-head">{section.label}</h2>}
                            {section.recordings.map((recording) => row(recording, section.label))}
                        </section>
                    ))}
                    {data && !all.length && (
                        <div className="empty">
                            <p className="section-head">No recordings</p>
                            <p className="muted">Recordings in {data.dir} show up here.</p>
                        </div>
                    )}
                </div>
                {summaryRecording && (
                    <SummaryPanel
                        recording={summaryRecording}
                        pinned={!!summary?.pinned}
                        onClose={() => setSummary(null)}
                        onEnter={() => clearTimeout(hideTimer.current)}
                        onLeave={hideSummary}
                    />
                )}
            </div>
            {trayOpen && (
                <UploadTray
                    tray={tray}
                    error={trayError}
                    login={login}
                    onLogin={() => setLogin(true)}
                    onCloseLogin={() => setLogin(false)}
                    onChange={refreshTray}
                    onClose={() => setTrayOpen(false)}
                />
            )}
            {dialog?.kind === "rename" && (
                <RenameDialog
                    name={dialog.recording.name}
                    onClose={() => setDialog(null)}
                    onRename={(name) =>
                        api.rename(dialog.recording.id, name).then(
                            (r) => toast(`renamed to ${r.id}`, "ok"),
                            fail,
                        )}
                />
            )}
            {dialog?.kind === "delete" && (
                <ConfirmDialog
                    title="Delete"
                    danger
                    action="Delete"
                    body={
                        <p>
                            Delete <span className="mono">{dialog.recording.name}</span>{" "}
                            ({bytes(dialog.recording.size)})?
                            {dialog.recording.symlink
                                ? " It's a link: only the link goes, not the file it points to."
                                : " This can't be undone."}
                        </p>
                    }
                    onClose={() => setDialog(null)}
                    onConfirm={() =>
                        api.remove(dialog.recording.id).then(
                            () => toast(`deleted ${dialog.recording.name}`, "ok"),
                            fail,
                        )}
                />
            )}
        </div>
    )
}

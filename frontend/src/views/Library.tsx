// The recordings list: sort, date sections, previews, the Summary panel, Open / actions menus, conversions and
// uploads. Every action is a backend endpoint (api.ts), the same ones Desktop's agent calls.
import { useEffect, useState } from "react"
import {
    api,
    bytes,
    type DrivesResponse,
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
import { appEvents } from "../dim-app/events.js"
import { useBackendState } from "../dim-app/react.js"
import { EmptyState } from "../EmptyState.tsx"
import { inDesktopShell, openApp } from "../dim-app/desktop.js"
import { ConfirmDialog, HoverMenu, type MenuItem, RenameDialog, Thumbnail, toast } from "../ui.tsx"
import { SummaryPanel } from "./SummaryPanel.tsx"
import { TransferDialog } from "./Transfer.tsx"
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

// a phone (the same breakpoint as app.css): the summary is a sheet a row's Summary button opens, not a side panel
const PHONE = "(max-width: 900px)"
function usePhone() {
    const [phone, setPhone] = useState(() => matchMedia(PHONE).matches)
    useEffect(() => {
        const query = matchMedia(PHONE)
        const change = () => setPhone(query.matches)
        query.addEventListener("change", change)
        return () => query.removeEventListener("change", change)
    }, [])
    return phone
}

// a click on a row's own controls (buttons, menus, links) is that control's, not a selection
const ownControl = (target: EventTarget | null) =>
    target instanceof Element && !!target.closest("button, a, input, textarea, select, label, .menu-wrap, .rrd")

const fail = (error: unknown) => toast(String((error as Error)?.message ?? error), "danger")

type DialogState =
    | { kind: "rename"; recording: Recording | RrdFile }
    | { kind: "delete"; recording: Recording | RrdFile }
    | null

export function Library({ transfer = false }: { transfer?: boolean }) {
    const [sort, setSort] = useState<SortKey>(saved("sort", "date"))
    const [order, setOrder] = useState<Order>(saved("order", "desc"))
    const [jobs, setJobs] = useState<Record<string, Job>>({})
    const [dialog, setDialog] = useState<DialogState>(null)
    // the selected recording: its summary shows in the side panel (desktop) or the sheet (phone)
    const [selected, setSelected] = useState<string | null>(null)
    const phone = usePhone()
    const [trayOpen, setTrayOpen] = useState(false)
    const [login, setLogin] = useState(false)
    const [thumbVersion, setThumbVersion] = useState(1)
    const { tray, error: trayError, refresh: refreshTray } = useTray()
    // plugged-in drives with recordings: a Transfer button while there are any (state/drives)
    const [drives] = useBackendState<DrivesResponse>("api/drives", { key: "drives" })
    const onDrives = drives?.drives.reduce((sum, drive) => sum + drive.files.length, 0) ?? 0

    // the list is backend state: GET api/recordings, re-GET when the backend's stateChanged("recordings") arrives
    // (zenoh, frontend topic state/recordings) and after the zenoh-web connection comes back
    const [data, { error: listError }] = useBackendState<ListResponse>(
        `api/recordings?sort=${sort}&order=${order}&tz=${new Date().getTimezoneOffset()}`,
        { key: "recordings" },
    )
    const error = listError ? String(listError.message ?? listError) : null

    // live: the backend's events (a preview finished, a job moved), on its frontend topic `events`
    useEffect(() =>
        appEvents((event) => {
            if (event.type === "job") {
                const job = event.job as Job
                setJobs((current) => ({ ...current, [job.id]: job }))
                if (job.state === "done") {
                    toast(`${job.phase}`, "ok")
                } else if (job.state === "failed") {
                    toast(`converting failed: ${job.error}`, "danger")
                }
            } else if (event.type === "thumbnail") {
                setThumbVersion((v) => v + 1)
            }
        }), [])
    useEffect(() => {
        api.jobs().then(
            ({ jobs }) => setJobs(Object.fromEntries(jobs.map((job) => [job.id, job]))),
            () => {},
        )
    }, [])

    const all = data?.sections.flatMap((s) => s.recordings) ?? []
    const summaryRecording = selected ? all.find((r) => r.id === selected && r.format !== "rrd") : undefined
    const uploadsByPath = new Map<string, Upload>(
        (tray?.uploads ?? []).map((u) => [u.path, u]),
    )

    // ↑ / ↓ move the selection through the list (desktop), Esc closes the summary; not while typing or in a dialog
    const selectable = all.filter((r) => r.format !== "rrd").map((r) => r.id)
    useEffect(() => {
        const keydown = (event: KeyboardEvent) => {
            const target = event.target as Element | null
            if (
                dialog || transfer ||
                target?.closest?.("input, textarea, select, [contenteditable=true], [role=dialog]")
            ) {
                return
            }
            if (event.key === "Escape" && selected) {
                setSelected(null)
                return
            }
            if (phone || (event.key !== "ArrowDown" && event.key !== "ArrowUp") || !selectable.length) {
                return
            }
            event.preventDefault()
            const index = selected ? selectable.indexOf(selected) : -1
            const next = index < 0
                ? (event.key === "ArrowDown" ? 0 : selectable.length - 1)
                : Math.max(0, Math.min(selectable.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))
            setSelected(selectable[next])
            document.querySelector(`.row[data-id="${CSS.escape(selectable[next])}"]`)?.scrollIntoView({
                block: "nearest",
            })
        }
        addEventListener("keydown", keydown)
        return () => removeEventListener("keydown", keydown)
    }, [selectable.join("\n"), selected, phone, dialog, transfer])

    const open = (recording: Recording | RrdFile, target: string) => {
        if (target === "replayer") {
            go({ view: "replay", id: recording.id })
            return
        }
        // an app (Map Editor, Rerun) gets the recording, then opens in this window through the shell, so the
        // browser's Back comes back here; outside Desktop's shell the backend switches Desktop's last window
        const inShell = inDesktopShell()
        api.open(recording.id, target, !inShell).then(
            (r) => {
                if (inShell && r.app) {
                    openApp(r.app)
                } else {
                    toast(`opened ${r.opened}`, "ok")
                }
            },
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
    ]

    const openMenu = (recording: Recording | RrdFile, testId: string) => (
        <HoverMenu
            label="Open ▾"
            className="primary"
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
                <span className="action-sep" aria-hidden="true" />
                <button
                    type="button"
                    className="dim-btn sm danger delete"
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
                className={`row selectable ${selected === recording.id ? "active" : ""}`}
                key={recording.id}
                data-id={recording.id}
                aria-selected={selected === recording.id}
                onClick={(event) => !phone && !ownControl(event.target) && setSelected(recording.id)}
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
                    {phone && (
                        <button
                            type="button"
                            className="dim-btn sm"
                            onClick={() => setSelected(recording.id)}
                        >
                            Summary
                        </button>
                    )}
                    {openMenu(recording, `open-${recording.id}`)}
                    <div className="action-group" role="group" aria-label="manage">
                        {link
                            ? (
                                <a
                                    className="dim-btn sm"
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
                                    {liveUpload?.state === "queued" && tray &&
                                            (tray.waitingForLogin || !tray.account.loggedIn)
                                        ? "Waiting for login"
                                        : liveUpload?.state === "uploading" ||
                                                liveUpload?.state === "queued"
                                        ? "Uploading…"
                                        : "Upload"}
                                </button>
                            )}
                        <button
                            type="button"
                            className="dim-btn sm"
                            onClick={() => setDialog({ kind: "rename", recording })}
                        >
                            Rename
                        </button>
                        <HoverMenu
                            label="⋯"
                            className="more"
                            items={actions(recording)}
                            testId={`more-${recording.id}`}
                        />
                    </div>
                    <span className="action-sep" aria-hidden="true" />
                    <button
                        type="button"
                        className="dim-btn sm danger delete"
                        data-testid={`delete-${recording.id}`}
                        onClick={() => setDialog({ kind: "delete", recording })}
                    >
                        Delete
                    </button>
                </div>
            </div>
        )
    }

    const active = (tray?.uploads ?? []).filter((u) => u.state === "queued" || u.state === "uploading").length
    return (
        <div className={`library ${summaryRecording && !phone ? "with-summary" : ""}`}>
            <header className="bar">
                <span className="dim-title">Recordings</span>
                <span className="mono muted small dir" title="the recordings folder">
                    {data?.dir}
                </span>
                <div className="spacer" />
                <div className="sorts" role="group" aria-label="sort">
                    {SORTS.map((s) => (
                        <button
                            key={s.key}
                            type="button"
                            className={`dim-btn sm ${sort === s.key ? "on" : "ghost"}`}
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
                {onDrives > 0 && (
                    <button
                        type="button"
                        className="dim-btn sm primary"
                        data-testid="transfer-button"
                        title={`recordings on ${drives?.drives.map((d) => d.name).join(", ")}`}
                        onClick={() => go({ view: "library", transfer: true })}
                    >
                        Transfer recordings · {onDrives}
                    </button>
                )}
                <button
                    type="button"
                    className={`dim-btn sm ${trayOpen ? "on" : ""}`}
                    onClick={() => setTrayOpen(!trayOpen)}
                >
                    Uploads{active ? ` · ${active}` : ""}
                </button>
            </header>
            {error && (
                <p className="error banner" data-testid="onboard-backend-down">
                    The Recordings server isn't answering ({error}). It retries by itself; if this stays, close the app
                    (✕) and open it again.
                </p>
            )}
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
                        <div className="empty" data-testid="onboard-no-recordings">
                            <EmptyState
                                label="No recordings"
                                title="You don't have any recordings yet"
                                body={`Record a robot with the Controller app: run a blueprint (or a replay), open the Controller's Record tab and press Record. New recordings in ${data.dir} show up here by themselves.`}
                                actions={[
                                    {
                                        label: "Record with the Controller",
                                        app: "dim-controller",
                                        appTitle: "the Controller",
                                    },
                                    {
                                        label: "Open the Launcher",
                                        app: "launcher",
                                        params: { kind: "blueprint" },
                                        primary: false,
                                    },
                                ]}
                            />
                        </div>
                    )}
                </div>
                {summaryRecording && (
                    <SummaryPanel
                        recording={summaryRecording}
                        sheet={phone}
                        onClose={() => setSelected(null)}
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
            {transfer && <TransferDialog onClose={() => go({ view: "library" })} />}
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

// The recordings: a list on the left (search, a warnings filter, sort, date sections with previews; a row's context
// menu, ⋯ or a long press offers Select, which ticks several for one Upload / Delete) and the selected recording in
// the Inspector on the right (a phone shows one at a time). Every action is a backend endpoint (api.ts), the same ones
// Desktop's agent calls.
import { useEffect, useMemo, useRef, useState } from "react"
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
import { ConfirmDialog, type FloatAt, FloatMenu, type MenuItem, RenameDialog, Thumbnail, toast } from "../ui.tsx"
import { Inspector, type InspectorActions } from "./Inspector.tsx"
import { TransferDialog } from "./Transfer.tsx"
import { UploadTray, useTray } from "./Uploads.tsx"

const SORTS: { key: SortKey; order: Order; label: string }[] = [
    { key: "date", order: "desc", label: "Newest" },
    { key: "date", order: "asc", label: "Oldest" },
    { key: "size", order: "desc", label: "Largest" },
    { key: "duration", order: "desc", label: "Longest" },
    { key: "name", order: "asc", label: "Name" },
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

// a phone (the same breakpoint as app.css): the list or the inspector, one at a time
const PHONE = "(max-width: 760px)"
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

const fail = (error: unknown) => toast(String((error as Error)?.message ?? error), "danger")

type Item = Recording | RrdFile
type DialogState =
    | { kind: "rename"; recording: Item }
    | { kind: "delete"; recordings: Item[] }
    | null

export function Library({ transfer = false }: { transfer?: boolean }) {
    const [sort, setSort] = useState<SortKey>(saved("sort", "date"))
    const [order, setOrder] = useState<Order>(saved("order", "desc"))
    const [query, setQuery] = useState("")
    const [onlyWarnings, setOnlyWarnings] = useState(false)
    const [jobs, setJobs] = useState<Record<string, Job>>({})
    const [dialog, setDialog] = useState<DialogState>(null)
    const [selected, setSelected] = useState<string | null>(null)
    const [renaming, setRenaming] = useState(false)
    // multi-select: null when off, else the ticked ids and the last one ticked (shift-click ranges from it)
    const [picking, setPicking] = useState<{ ids: Set<string>; anchor: string | null } | null>(null)
    const [menu, setMenu] = useState<{ at: FloatAt; items: MenuItem[] } | null>(null)
    const [sortMenu, setSortMenu] = useState<HTMLElement | null>(null)
    const phone = usePhone()
    const [showDetail, setShowDetail] = useState(false)
    const [trayOpen, setTrayOpen] = useState(false)
    const [login, setLogin] = useState(false)
    const [thumbVersion, setThumbVersion] = useState(1)
    const { tray, error: trayError, refresh: refreshTray } = useTray()
    // plugged-in drives with recordings: a Transfer button while there are any (state/drives)
    const [drives] = useBackendState<DrivesResponse>("api/drives", { key: "drives" })
    const onDrives = drives?.drives.reduce((sum, drive) => sum + drive.files.length, 0) ?? 0

    // the list is backend state: GET api/recordings, re-GET when the backend's stateChanged("recordings") arrives
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

    // the sections, filtered by the search (name, note, streams) and the warnings chip
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const matches = (r: Recording) =>
        (!onlyWarnings || (r.warnings ?? 0) > 0) &&
        words.every((word) => `${r.name} ${r.note} ${r.summary ?? ""}`.toLowerCase().includes(word))
    const sections = useMemo(
        () =>
            (data?.sections ?? [])
                .map((s) => ({ ...s, recordings: s.recordings.filter(matches) }))
                .filter((s) => s.recordings.length),
        [data, query, onlyWarnings],
    )
    const everything = data?.sections.flatMap((s) => s.recordings) ?? []
    const shown = sections.flatMap((s) => s.recordings)
    const flagged = everything.filter((r) => (r.warnings ?? 0) > 0).length
    const current = selected ? everything.find((r) => r.id === selected) : undefined
    const inspected = current && current.format !== "rrd" ? current : undefined
    const uploadsByPath = new Map<string, Upload>((tray?.uploads ?? []).map((u) => [u.path, u]))
    const waitingForLogin = !!tray && (tray.waitingForLogin || !tray.account.loggedIn)

    // on a wide screen something is always selected: the first recording until one is picked
    useEffect(() => {
        if (!phone && !current && shown.length) {
            setSelected(shown.find((r) => r.format !== "rrd")?.id ?? shown[0].id)
        }
    }, [phone, current?.id, shown.map((r) => r.id).join("\n")])
    // a rename moves the id: follow it
    const select = (id: string) => {
        setSelected(id)
        setRenaming(false)
        setShowDetail(true)
    }

    // ↑ / ↓ move through the list; Esc leaves Select; not while typing or in a dialog or menu
    useEffect(() => {
        const keydown = (event: KeyboardEvent) => {
            const target = event.target as Element | null
            if (dialog || transfer || menu || target?.closest?.("input, textarea, select, [contenteditable]")) {
                return
            }
            if (event.key === "Escape" && picking) {
                setPicking(null)
                return
            }
            if (event.key === "Escape" && phone && showDetail) {
                setShowDetail(false)
                return
            }
            if ((event.key !== "ArrowDown" && event.key !== "ArrowUp") || !shown.length || picking) {
                return
            }
            if (target?.closest?.("[data-testid=preview]")) {
                return
            }
            event.preventDefault()
            const ids = shown.map((r) => r.id)
            const index = selected ? ids.indexOf(selected) : -1
            const next = index < 0
                ? (event.key === "ArrowDown" ? 0 : ids.length - 1)
                : Math.max(0, Math.min(ids.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))
            setSelected(ids[next])
            document.querySelector(`.item[data-id="${CSS.escape(ids[next])}"]`)?.scrollIntoView({ block: "nearest" })
        }
        addEventListener("keydown", keydown)
        return () => removeEventListener("keydown", keydown)
    }, [shown.map((r) => r.id).join("\n"), selected, phone, dialog, transfer, menu, picking, showDetail])

    const open = (recording: Item, target: string) => {
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
    /** queues each (Desktop's dimos gateway uploads them one at a time) and opens the tray */
    const upload = async (recordings: Recording[]) => {
        const todo = recordings.filter((r) => {
            const live = uploadsByPath.get(r.path)
            return !live || (live.state !== "queued" && live.state !== "uploading")
        })
        if (!todo.length) {
            setTrayOpen(true)
            return
        }
        let queued = 0
        for (const recording of todo) {
            try {
                await api.upload(recording.id)
                queued++
            } catch (e) {
                fail(e)
            }
        }
        if (queued) {
            toast(queued === 1 ? `uploading ${todo[0].name}` : `queued ${queued} uploads`, "ok")
            setTrayOpen(true)
            if (tray && !tray.account.loggedIn) {
                setLogin(true)
            }
        }
        refreshTray()
    }
    const remove = async (recordings: Item[]) => {
        let gone = 0
        for (const recording of recordings) {
            try {
                await api.remove(recording.id)
                gone++
            } catch (e) {
                fail(e)
            }
        }
        if (gone) {
            toast(gone === 1 ? `deleted ${recordings[0].name}` : `deleted ${gone} recordings`, "ok")
        }
        setPicking(null)
    }
    const rename = (recording: Item, name: string) =>
        api.rename(recording.id, name).then(
            (r) => {
                toast(`renamed to ${r.id}`, "ok")
                if (selected === recording.id) {
                    setSelected(r.id)
                }
                setRenaming(false)
            },
            (e) => {
                fail(e)
                setRenaming(false)
            },
        )
    const copyPath = (recording: Item) => {
        navigator.clipboard.writeText(recording.path).then(
            () => toast("path copied", "ok"),
            () => toast(recording.path, "info"),
        )
    }

    const opensMenu = (recording: Item): MenuItem[] =>
        recording.opens.filter((o) => o.target !== "replayer").map((o) => ({
            label: o.label,
            hint: o.ok ? undefined : o.reason,
            disabled: !o.ok,
            onSelect: () => open(recording, o.target),
        }))
    const moreMenu = (recording: Recording): MenuItem[] => [
        {
            label: "Duplicate",
            onSelect: () => api.duplicate(recording.id).then((r) => toast(`made ${r.id}`, "ok"), fail),
        },
        ...recording.conversions.map((c) => ({
            label: `Convert to .${c.to}`,
            hint: c.ok ? undefined : c.reason,
            disabled: !c.ok ||
                Object.values(jobs).some((j) => j.recording === recording.id && j.state === "running"),
            onSelect: () =>
                api.convert(recording.id, c.to).then(
                    (job) => setJobs((current) => ({ ...current, [job.id]: job })),
                    fail,
                ),
        })),
        ...recording.rrds.flatMap((rrd): MenuItem[] => [
            { separator: true },
            { heading: rrd.name },
            { label: "Open in Rerun", onSelect: () => open(rrd, "rerun"), disabled: !rrd.opens[0]?.ok },
            { label: "Delete .rrd", danger: true, onSelect: () => setDialog({ kind: "delete", recordings: [rrd] }) },
        ]),
        { separator: true },
        { label: "Copy path", onSelect: () => copyPath(recording) },
        { label: "Show in folder", onSelect: () => api.reveal(recording.id).then(() => {}, fail) },
    ]

    const pickedItems = picking ? everything.filter((r) => picking.ids.has(r.id)) : []
    const pickedRecordings = pickedItems.filter((r): r is Recording => r.format !== "rrd")
    const startPicking = (id: string) => setPicking({ ids: new Set([id]), anchor: id })
    const toggle = (id: string, range: boolean) => {
        setPicking((current) => {
            const ids = new Set(current?.ids ?? [])
            const order = shown.map((r) => r.id)
            if (range && current?.anchor) {
                const [a, b] = [order.indexOf(current.anchor), order.indexOf(id)].sort((x, y) => x - y)
                if (a >= 0) {
                    order.slice(a, b + 1).forEach((x) => ids.add(x))
                    return { ids, anchor: current.anchor }
                }
            }
            ids.has(id) ? ids.delete(id) : ids.add(id)
            return { ids, anchor: id }
        })
    }

    const rowMenu = (recording: Item, at: FloatAt) => {
        if (picking) {
            const list = picking.ids.size ? pickedItems : [recording]
            const recordings = list.filter((r): r is Recording => r.format !== "rrd")
            setMenu({
                at,
                items: [
                    { heading: `${list.length} selected` },
                    { label: "Upload", disabled: !recordings.length, onSelect: () => upload(recordings) },
                    { label: "Delete…", danger: true, onSelect: () => setDialog({ kind: "delete", recordings: list }) },
                    { separator: true },
                    {
                        label: "Select all",
                        onSelect: () => setPicking({ ids: new Set(shown.map((r) => r.id)), anchor: null }),
                    },
                    { label: "Done selecting", hint: "Esc", onSelect: () => setPicking(null) },
                ],
            })
            return
        }
        const items: MenuItem[] = [
            { label: "Select", hint: "pick several", onSelect: () => startPicking(recording.id) },
            { separator: true },
        ]
        if (recording.format === "rrd") {
            items.push(...opensMenu(recording))
        } else {
            items.push(
                { label: "Replay", onSelect: () => open(recording, "replayer") },
                {
                    label: "Rename",
                    onSelect: () => {
                        select(recording.id)
                        setRenaming(true)
                    },
                },
                { label: "Upload", onSelect: () => upload([recording as Recording]) },
            )
        }
        items.push(
            { separator: true },
            { label: "Delete…", danger: true, onSelect: () => setDialog({ kind: "delete", recordings: [recording] }) },
        )
        setMenu({ at, items })
    }

    const longPress = useRef<{ timer?: number; fired?: boolean }>({})
    const row = (recording: Item, section: string | null) => {
        const isRrd = recording.format === "rrd"
        const r = recording as Recording
        const warningCount = isRrd ? 0 : r.warnings ?? 0
        const live = isRrd ? undefined : uploadsByPath.get(recording.path)
        const ticked = !!picking?.ids.has(recording.id)
        return (
            <div
                key={recording.id}
                className={`item ${!picking && selected === recording.id ? "on" : ""} ${ticked ? "picked" : ""}`}
                data-id={recording.id}
                data-testid={`item-${recording.id}`}
                aria-selected={picking ? ticked : selected === recording.id}
                onClick={(event) => {
                    if (longPress.current.fired) {
                        longPress.current.fired = false
                        return
                    }
                    if ((event.target as Element).closest(".kebab")) {
                        return
                    }
                    if (picking) {
                        toggle(recording.id, event.shiftKey)
                    } else {
                        select(recording.id)
                    }
                }}
                onContextMenu={(event) => {
                    event.preventDefault()
                    rowMenu(recording, { x: event.clientX, y: event.clientY })
                }}
                onPointerDown={(event) => {
                    if (event.pointerType === "mouse") {
                        return
                    }
                    const { clientX: x, clientY: y } = event
                    clearTimeout(longPress.current.timer)
                    longPress.current.timer = setTimeout(() => {
                        longPress.current.fired = true
                        rowMenu(recording, { x, y })
                    }, 500)
                }}
                onPointerUp={() => clearTimeout(longPress.current.timer)}
                onPointerCancel={() => clearTimeout(longPress.current.timer)}
                onPointerMove={(event) => {
                    if (Math.abs(event.movementX) + Math.abs(event.movementY) > 6) {
                        clearTimeout(longPress.current.timer)
                    }
                }}
            >
                <i className="ck" aria-hidden="true" />
                {isRrd
                    ? (
                        <div className="thumb placeholder none rrd-thumb">
                            <span>.rrd</span>
                        </div>
                    )
                    : <Thumbnail id={recording.id} thumb={r.thumbnail} version={thumbVersion} />}
                <div className="t">
                    <div className="n" title={recording.path}>{recording.name}</div>
                    <div className="m">
                        {isRrd
                            ? `rerun · ${bytes(recording.size)}`
                            : `${r.inspected ? duration(r.duration) : "…"} · ${bytes(recording.size)} · ${
                                when(r.recorded, section)
                            }`}
                    </div>
                    {live && (live.state === "uploading" || live.state === "queued") && (
                        <div className="m up">{live.state === "queued" ? "queued for upload" : "uploading…"}</div>
                    )}
                </div>
                <div className="s">
                    {!isRrd && (
                        <span
                            className="st"
                            title={r.warnings === null
                                ? "not read yet"
                                : warningCount
                                ? `${warningCount} warnings`
                                : "no issues found"}
                        >
                            {r.error ? <span className="warn">!</span> : warningCount
                                ? (
                                    <span className="warn">
                                        <i className="dot warn" /> {warningCount}
                                    </span>
                                )
                                : <i className={`dot ${r.warnings === null ? "off" : ""}`} />}
                        </span>
                    )}
                    <button
                        type="button"
                        className="dim-btn sm ghost kebab"
                        aria-label="More"
                        aria-haspopup="menu"
                        onClick={(event) => {
                            event.stopPropagation()
                            rowMenu(recording, { anchor: event.currentTarget })
                        }}
                    >
                        ⋯
                    </button>
                </div>
            </div>
        )
    }

    const active = (tray?.uploads ?? []).filter((u) => u.state === "queued" || u.state === "uploading").length
    const total = everything.reduce((sum, r) => sum + r.size, 0)
    const free = drives?.destination.free ?? null
    const capacity = drives?.destination.total ?? null
    const sortLabel = SORTS.find((s) => s.key === sort && s.order === order)?.label ??
        `${sort} ${order === "desc" ? "↓" : "↑"}`
    const inspectorActions = (recording: Recording): InspectorActions => ({
        replay: () => open(recording, "replayer"),
        rename: () => setRenaming(true),
        upload: () => upload([recording]),
        remove: () => setDialog({ kind: "delete", recordings: [recording] }),
        opens: opensMenu(recording),
        more: moreMenu(recording),
    })
    const deleting = dialog?.kind === "delete" ? dialog.recordings : []

    return (
        <div
            className={`library inspector-layout ${picking ? "selecting" : ""} ${
                phone && showDetail && inspected ? "show-detail" : ""
            }`}
        >
            <aside className="list" aria-label="Recordings">
                <header>
                    <div className="row">
                        <span className="dim-title">Recordings</span>
                        <span className="grow" />
                        {onDrives > 0 && (
                            <button
                                type="button"
                                className="dim-btn sm primary"
                                data-testid="transfer-button"
                                title={`recordings on ${drives?.drives.map((d) => d.name).join(", ")}`}
                                onClick={() => go({ view: "library", transfer: true })}
                            >
                                Transfer · {onDrives}
                            </button>
                        )}
                        <button
                            type="button"
                            className={`dim-btn sm ${trayOpen ? "on" : ""}`}
                            data-testid="uploads-button"
                            onClick={() => setTrayOpen(!trayOpen)}
                        >
                            Uploads{active ? ` · ${active}` : ""}
                        </button>
                    </div>
                    <input
                        type="search"
                        className="dim-input"
                        placeholder="Search names, notes, topics…"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        data-testid="search"
                    />
                    <div className="row">
                        <div className="chips">
                            <button
                                type="button"
                                className="dim-chip"
                                aria-pressed={!onlyWarnings}
                                onClick={() => setOnlyWarnings(false)}
                            >
                                All
                            </button>
                            <button
                                type="button"
                                className="dim-chip warn"
                                aria-pressed={onlyWarnings}
                                title="only the recordings with warnings"
                                onClick={() => setOnlyWarnings(!onlyWarnings)}
                            >
                                ⚠ {flagged}
                            </button>
                        </div>
                        <span className="grow" />
                        <button
                            type="button"
                            className="dim-btn sm ghost"
                            aria-haspopup="menu"
                            onClick={(event) => setSortMenu(event.currentTarget)}
                        >
                            {sortLabel} ▾
                        </button>
                    </div>
                </header>
                {error && (
                    <p className="error banner small" data-testid="onboard-backend-down">
                        The Recordings server isn't answering ({error}). It retries by itself; if this stays, close the
                        app (✕) and open it again.
                    </p>
                )}
                <div className="items">
                    {sections.map((section, index) => (
                        <section key={section.label ?? index}>
                            {section.label && (
                                <div className="grp">
                                    <span className="section-head">{section.label}</span>
                                    <span className="mono small muted">
                                        {section.recordings.length} ·{" "}
                                        {bytes(section.recordings.reduce((sum, r) => sum + r.size, 0))}
                                    </span>
                                </div>
                            )}
                            {section.recordings.map((recording) => row(recording, section.label))}
                        </section>
                    ))}
                    {data && everything.length > 0 && !shown.length && (
                        <p className="muted small nothing">Nothing matches.</p>
                    )}
                    {data && !everything.length && (
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
                {picking
                    ? (
                        <div className="selbar" data-testid="selbar">
                            <div className="count">
                                {picking.ids.size} selected
                                <small>{bytes(pickedItems.reduce((sum, r) => sum + r.size, 0))}</small>
                            </div>
                            <button
                                type="button"
                                className="dim-btn sm"
                                disabled={!pickedRecordings.length}
                                onClick={() => upload(pickedRecordings).then(() => setPicking(null))}
                            >
                                Upload
                            </button>
                            <button
                                type="button"
                                className="dim-btn sm delete"
                                disabled={!pickedItems.length}
                                onClick={() => setDialog({ kind: "delete", recordings: pickedItems })}
                            >
                                Delete
                            </button>
                            <button type="button" className="dim-btn sm ghost" onClick={() => setPicking(null)}>
                                Cancel
                            </button>
                        </div>
                    )
                    : (
                        <footer>
                            <div className="mono small muted totals">
                                <span>
                                    {everything.length} {everything.length === 1 ? "recording" : "recordings"} ·{" "}
                                    {bytes(total)}
                                </span>
                                {free !== null && <span>{bytes(free)} free</span>}
                            </div>
                            {free !== null && capacity && (
                                <div className="space" title={data?.dir}>
                                    <i style={{ width: `${Math.min(100, ((capacity - free) / capacity) * 100)}%` }} />
                                </div>
                            )}
                        </footer>
                    )}
            </aside>
            {inspected
                ? (
                    <Inspector
                        key={inspected.id}
                        recording={inspected}
                        actions={inspectorActions(inspected)}
                        upload={uploadsByPath.get(inspected.path)}
                        waitingForLogin={waitingForLogin}
                        jobs={Object.values(jobs)}
                        version={thumbVersion}
                        onBack={() => setShowDetail(false)}
                        renaming={renaming}
                        onRenamed={(name) => rename(inspected, name)}
                        onCancelRename={() => setRenaming(false)}
                    />
                )
                : current
                ? (
                    <section className="detail rrd-detail" data-testid="inspector">
                        <div className="pane">
                            <p className="name mono">{current.name}</p>
                            <p className="muted small">a Rerun recording · {bytes(current.size)}</p>
                            <div className="row-actions">
                                <button
                                    type="button"
                                    className="dim-btn sm primary"
                                    disabled={!current.opens[0]?.ok}
                                    title={current.opens[0]?.reason}
                                    onClick={() => open(current, "rerun")}
                                >
                                    Open in Rerun
                                </button>
                                <button
                                    type="button"
                                    className="dim-btn sm delete"
                                    onClick={() => setDialog({ kind: "delete", recordings: [current] })}
                                >
                                    Delete
                                </button>
                            </div>
                        </div>
                    </section>
                )
                : <section className="detail empty-detail" />}
            {menu && <FloatMenu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />}
            {sortMenu && (
                <FloatMenu
                    at={{ anchor: sortMenu }}
                    onClose={() => setSortMenu(null)}
                    items={SORTS.map((s) => ({
                        label: s.label,
                        hint: s.key === sort && s.order === order ? "✓" : undefined,
                        onSelect: () => {
                            setSort(s.key)
                            setOrder(s.order)
                            save("sort", s.key)
                            save("order", s.order)
                        },
                    }))}
                />
            )}
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
                    onRename={(name) => rename(dialog.recording, name)}
                />
            )}
            {dialog?.kind === "delete" && (
                <ConfirmDialog
                    title={deleting.length === 1 ? "Delete recording" : `Delete ${deleting.length} recordings`}
                    danger
                    action="Delete"
                    body={
                        <>
                            <p>
                                {bytes(deleting.reduce((sum, r) => sum + r.size, 0))} will be removed from{" "}
                                <span className="mono">{data?.dir}</span>.
                                {deleting.some((r) => r.symlink)
                                    ? " Links go, not the files they point to."
                                    : " This can't be undone."}
                            </p>
                            <div className="names mono small" data-testid="delete-names">
                                {deleting.map((r) => <div key={r.id}>{r.name}</div>)}
                            </div>
                        </>
                    }
                    onClose={() => setDialog(null)}
                    onConfirm={() => remove(deleting)}
                />
            )}
        </div>
    )
}

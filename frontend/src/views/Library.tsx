// The recordings: a list on the left (search, a warnings filter, sort, date sections with previews; a row's context
// menu, ⋯ or a long press offers Select, which ticks several for one Upload / Delete) and the selected recording in
// the Inspector on the right (a phone shows one at a time). Every action is a backend endpoint (api.ts), the same ones
// Desktop's agent calls.
import { useEffect, useMemo, useState } from "react"
import {
    Alert,
    Badge,
    Button,
    Checkbox,
    Chip,
    ContextMenu,
    EmptyState,
    IconButton,
    ListRow,
    Menu,
    Modal,
    Progress,
    SearchInput,
    StatusDot,
    Text,
    toast,
    useBackendEvents,
    useBackendState,
    useConfirm,
    useMobile,
    usePrompt,
} from "dimos-react"
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
import { usePersistentState } from "../typed.ts"
import { inDesktopShell, openApp } from "../dim-app/source/desktop.js"
import { Inspector, type InspectorActions, type MenuItem } from "./Inspector.tsx"
import { TransferDialog } from "./Transfer.tsx"
import { openCloudLogin, UploadTray, useTray } from "./Uploads.tsx"
import { Thumbnail } from "./Thumbnail.tsx"

const SORTS: { key: SortKey; order: Order; label: string }[] = [
    { key: "date", order: "desc", label: "Newest" },
    { key: "date", order: "asc", label: "Oldest" },
    { key: "size", order: "desc", label: "Largest" },
    { key: "duration", order: "desc", label: "Longest" },
    { key: "name", order: "asc", label: "Name" },
]

export const fail = (error: unknown) => toast.error(String((error as Error)?.message ?? error))

type Item = Recording | RrdFile

export function Library({ transfer = false }: { transfer?: boolean }) {
    const [sorting, setSorting] = usePersistentState<
        { sort: SortKey; order: Order }
    >("dim-recordings.sorting", {
        sort: "date",
        order: "desc",
    })
    const { sort, order } = sorting
    const [query, setQuery] = useState("")
    const [onlyWarnings, setOnlyWarnings] = useState(false)
    const [jobs, setJobs] = useState<Record<string, Job>>({})
    const [deleting, setDeleting] = useState<Item[] | null>(null)
    const [selected, setSelected] = useState<string | null>(null)
    // multi-select: null when off, else the ticked ids and the last one ticked (shift-click ranges from it)
    const [picking, setPicking] = useState<
        { ids: Set<string>; anchor: string | null } | null
    >(null)
    const phone = useMobile(760)
    const [showDetail, setShowDetail] = useState(false)
    const [trayOpen, setTrayOpen] = useState(false)
    const [thumbVersion, setThumbVersion] = useState(1)
    const prompt = usePrompt()
    const confirm = useConfirm()
    const { tray, error: trayError, refresh: refreshTray } = useTray()
    // plugged-in drives with recordings: a Transfer button while there are any (state/drives)
    const [drives] = useBackendState("drives", { url: "api/drives" }) as [
        DrivesResponse | undefined,
        unknown,
    ]
    const onDrives = drives?.drives.reduce((sum, drive) => sum + drive.files.length, 0) ?? 0

    // the list is backend state: GET api/recordings, re-GET when the backend's stateChanged("recordings") arrives
    const [data, { error: listError }] = useBackendState("recordings", {
        url: `api/recordings?sort=${sort}&order=${order}&tz=${new Date().getTimezoneOffset()}`,
    }) as [ListResponse | undefined, { error: Error | null }]
    const error = listError ? String(listError.message ?? listError) : null

    // live: the backend's events (a preview finished, a job moved), on its frontend topic `events`
    useBackendEvents((event: { type?: string; job?: Job }) => {
        if (event.type === "job" && event.job) {
            const job = event.job
            setJobs((current) => ({ ...current, [job.id]: job }))
            if (job.state === "done") {
                toast.ok(`${job.phase}`)
            } else if (job.state === "failed") {
                toast.error(`converting failed: ${job.error}`)
            }
        } else if (event.type === "thumbnail") {
            setThumbVersion((v) => v + 1)
        }
    })
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
    const uploadsByPath = new Map<string, Upload>(
        (tray?.uploads ?? []).map((u) => [u.recording ?? u.path, u]),
    )
    const waitingForLogin = !!tray &&
        (tray.waitingForLogin || !tray.account.loggedIn)

    // on a wide screen something is always selected: the first recording until one is picked
    useEffect(() => {
        if (!phone && !current && shown.length) {
            setSelected(shown.find((r) => r.format !== "rrd")?.id ?? shown[0].id)
        }
    }, [phone, current?.id, shown.map((r) => r.id).join("\n")])
    const select = (id: string) => {
        setSelected(id)
        setShowDetail(true)
    }

    // ↑ / ↓ move through the list; Esc leaves Select; not while typing or in a dialog or menu
    useEffect(() => {
        const keydown = (event: KeyboardEvent) => {
            const target = event.target as Element | null
            if (
                deleting || transfer ||
                target?.closest?.(
                    "input, textarea, select, [contenteditable], [role=menu]",
                ) ||
                document.querySelector(".dr-modal")
            ) {
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
            if (
                (event.key !== "ArrowDown" && event.key !== "ArrowUp") ||
                !shown.length || picking
            ) {
                return
            }
            if (target?.closest?.("[data-testid=preview]")) {
                return
            }
            event.preventDefault()
            const ids = shown.map((r) => r.id)
            const index = selected ? ids.indexOf(selected) : -1
            const next = index < 0 ? (event.key === "ArrowDown" ? 0 : ids.length - 1) : Math.max(
                0,
                Math.min(
                    ids.length - 1,
                    index + (event.key === "ArrowDown" ? 1 : -1),
                ),
            )
            setSelected(ids[next])
            document.querySelector(`[data-id="${CSS.escape(ids[next])}"]`)
                ?.scrollIntoView({ block: "nearest" })
        }
        addEventListener("keydown", keydown)
        return () => removeEventListener("keydown", keydown)
    }, [
        shown.map((r) => r.id).join("\n"),
        selected,
        phone,
        deleting,
        transfer,
        picking,
        showDetail,
    ])

    const open = (recording: Item, target: string) => {
        if (target === "replayer") {
            go({ view: "replay", id: recording.id })
            return
        }
        // an app (Map Editor, Rerun) gets the recording, then opens in this window through the shell, so the
        // browser's Back comes back here; outside Desktop's shell the backend switches Desktop's last window
        const inShell = inDesktopShell()
        api.open(recording.id, target, !inShell).then((r) => {
            if (inShell && r.app) {
                openApp(r.app)
            } else {
                toast.ok(`opened ${r.opened}`)
            }
        }, fail)
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
            toast.ok(
                queued === 1 ? `uploading ${todo[0].name}` : `queued ${queued} uploads`,
            )
            setTrayOpen(true)
            if (tray && !tray.account.loggedIn) {
                // the upload waits for the login: Desktop's Settings, which comes back here once it's done
                openCloudLogin()
            }
        }
        refreshTray()
    }
    /** uploads it again as name.vN (the earlier upload stays); asks first when its streams haven't changed */
    const reupload = async (recording: Recording) => {
        const uploaded = recording.uploaded
        const live = uploadsByPath.get(recording.path)
        if (!uploaded || (live && (live.state === "queued" || live.state === "uploading"))) {
            setTrayOpen(true)
            return
        }
        if (
            !uploaded.changed && !(await confirm({
                title: `Re-upload ${recording.name}`,
                message: uploaded.bytesChanged
                    ? `Its streams look the same as when it went up as ${uploaded.name}, though the file changed. Upload it again as ${uploaded.nextName}?`
                    : `It hasn't changed since it went up as ${uploaded.name}. Upload it again as ${uploaded.nextName}?`,
                confirmLabel: "Re-upload",
            }))
        ) {
            return
        }
        try {
            const queued = await api.reupload(recording.id, !uploaded.changed)
            toast.ok(`uploading ${queued.name}`)
            setTrayOpen(true)
            if (tray && !tray.account.loggedIn) {
                openCloudLogin()
            }
        } catch (e) {
            fail(e)
        }
        refreshTray()
    }
    const reuploadItem = (recording: Recording): MenuItem[] =>
        recording.uploaded
            ? [{
                label: `Re-upload as ${recording.uploaded.nextName}${recording.uploaded.changed ? "" : "…"}`,
                icon: "upload",
                title: recording.uploaded.changes.join("\n") || undefined,
                onSelect: () => reupload(recording),
            }]
            : []
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
            toast.ok(
                gone === 1 ? `deleted ${recordings[0].name}` : `deleted ${gone} recordings`,
            )
        }
        setPicking(null)
    }
    const rename = async (recording: Item) => {
        const dot = recording.name.lastIndexOf(".")
        const extension = dot > 0 ? recording.name.slice(dot) : ""
        const base = (await prompt({
            title: `Rename ${recording.name}`,
            defaultValue: dot > 0 ? recording.name.slice(0, dot) : recording.name,
            confirmLabel: "Rename",
            message: extension ? `It keeps its ${extension} extension.` : undefined,
        }))?.trim()
        if (!base || base + extension === recording.name) {
            return
        }
        api.rename(recording.id, base + extension).then((r) => {
            toast.ok(`renamed to ${r.id}`)
            if (selected === recording.id) {
                setSelected(r.id)
            }
        }, fail)
    }
    const copyPath = (recording: Item) => {
        navigator.clipboard.writeText(recording.path).then(
            () => toast.ok("path copied"),
            () => toast.info(recording.path),
        )
    }

    const opensMenu = (recording: Item): MenuItem[] =>
        recording.opens.filter((o) => o.target !== "replayer").map((o) => ({
            label: o.label,
            title: o.ok ? undefined : o.reason,
            disabled: !o.ok,
            onSelect: () => open(recording, o.target),
        }))
    const moreMenu = (recording: Recording): MenuItem[] => [
        ...reuploadItem(recording),
        {
            label: "Duplicate",
            icon: "copy",
            onSelect: () => api.duplicate(recording.id).then((r) => toast.ok(`made ${r.id}`), fail),
        },
        ...recording.conversions.map((c) => ({
            label: `Convert to .${c.to}`,
            title: c.ok ? undefined : c.reason,
            disabled: !c.ok ||
                Object.values(jobs).some((j) => j.recording === recording.id && j.state === "running"),
            onSelect: () =>
                api.convert(recording.id, c.to).then(
                    (job) => setJobs((cur) => ({ ...cur, [job.id]: job })),
                    fail,
                ),
        })),
        ...recording.rrds.flatMap((rrd): MenuItem[] => [
            "-",
            { heading: rrd.name },
            {
                label: "Open in Rerun",
                onSelect: () => open(rrd, "rerun"),
                disabled: !rrd.opens[0]?.ok,
            },
            {
                label: "Delete .rrd",
                danger: true,
                onSelect: () => setDeleting([rrd]),
            },
        ]),
        "-",
        { label: "Copy path", icon: "copy", onSelect: () => copyPath(recording) },
        {
            label: "Show in folder",
            icon: "folder",
            onSelect: () => api.reveal(recording.id).then(() => {}, fail),
        },
    ]

    const pickedItems = picking ? everything.filter((r) => picking.ids.has(r.id)) : []
    const pickedRecordings = pickedItems.filter((r): r is Recording => r.format !== "rrd")
    const startPicking = (id: string) => setPicking({ ids: new Set([id]), anchor: id })
    const toggle = (id: string, range: boolean) => {
        setPicking((current) => {
            const ids = new Set(current?.ids ?? [])
            const order = shown.map((r) => r.id)
            if (range && current?.anchor) {
                const [a, b] = [order.indexOf(current.anchor), order.indexOf(id)].sort((
                    x,
                    y,
                ) => x - y)
                if (a >= 0) {
                    order.slice(a, b + 1).forEach((x) => ids.add(x))
                    return { ids, anchor: current.anchor }
                }
            }
            ids.has(id) ? ids.delete(id) : ids.add(id)
            return { ids, anchor: id }
        })
    }

    const rowMenu = (recording: Item): MenuItem[] => {
        if (picking) {
            const list = picking.ids.size ? pickedItems : [recording]
            const recordings = list.filter((r): r is Recording => r.format !== "rrd")
            return [
                { heading: `${list.length} selected` },
                {
                    label: "Upload",
                    icon: "upload",
                    disabled: !recordings.length,
                    onSelect: () => upload(recordings),
                },
                {
                    label: "Delete…",
                    icon: "trash",
                    danger: true,
                    onSelect: () => setDeleting(list),
                },
                "-",
                {
                    label: "Select all",
                    onSelect: () => setPicking({ ids: new Set(shown.map((r) => r.id)), anchor: null }),
                },
                {
                    label: "Done selecting",
                    shortcut: "Esc",
                    onSelect: () => setPicking(null),
                },
            ]
        }
        const items: MenuItem[] = [
            {
                label: "Select",
                icon: "check",
                shortcut: "pick several",
                onSelect: () => startPicking(recording.id),
            },
            "-",
        ]
        if (recording.format === "rrd") {
            items.push(...opensMenu(recording))
        } else {
            items.push(
                {
                    label: "Replay",
                    icon: "play",
                    onSelect: () => open(recording, "replayer"),
                },
                { label: "Rename", icon: "edit", onSelect: () => rename(recording) },
                {
                    label: "Upload",
                    icon: "upload",
                    onSelect: () => upload([recording as Recording]),
                },
                ...reuploadItem(recording as Recording),
            )
        }
        items.push("-", {
            label: "Delete…",
            icon: "trash",
            danger: true,
            onSelect: () => setDeleting([recording]),
        })
        return items
    }

    const row = (recording: Item, section: string | null) => {
        const isRrd = recording.format === "rrd"
        const r = recording as Recording
        const warningCount = isRrd ? 0 : r.warnings ?? 0
        const live = isRrd ? undefined : uploadsByPath.get(recording.path)
        const ticked = !!picking?.ids.has(recording.id)
        const status = isRrd
            ? null
            : r.error
            ? <Badge tone="warn" title="unreadable">!</Badge>
            : warningCount
            ? (
                <Badge tone="warn" dot title={`${warningCount} warnings`}>
                    {warningCount}
                </Badge>
            )
            : (
                <StatusDot
                    tone={r.warnings === null ? "info" : "ok"}
                    label={r.warnings === null ? "not read yet" : "no issues found"}
                />
            )
        return (
            <ContextMenu key={recording.id} items={() => rowMenu(recording)}>
                <ListRow
                    className="rec-row"
                    data-id={recording.id}
                    data-testid={`item-${recording.id}`}
                    selected={picking ? ticked : selected === recording.id}
                    icon={
                        <span className="rec-row-lead">
                            {picking && (
                                <Checkbox
                                    value={ticked}
                                    aria-label={`pick ${recording.name}`}
                                />
                            )}
                            {isRrd
                                ? (
                                    <span className="rec-thumb rec-thumb-placeholder">
                                        <span>.rrd</span>
                                    </span>
                                )
                                : (
                                    <Thumbnail
                                        id={recording.id}
                                        thumb={r.thumbnail}
                                        version={thumbVersion}
                                    />
                                )}
                        </span>
                    }
                    title={<span title={recording.path}>{recording.name}</span>}
                    subtitle={
                        <>
                            {isRrd
                                ? `rerun · ${bytes(recording.size)}`
                                : `${r.inspected ? duration(r.duration) : "…"} · ${bytes(recording.size)} · ${
                                    when(r.recorded, section)
                                }`}
                            {live &&
                                (live.state === "uploading" || live.state === "queued") && (
                                <Text small as="div">
                                    {live.state === "queued" ? "queued for upload" : "uploading…"}
                                </Text>
                            )}
                            {r.uploaded?.changed &&
                                !(live?.state === "uploading" || live?.state === "queued") && (
                                <Text
                                    small
                                    as="div"
                                    title={r.uploaded.changes.join("\n") || undefined}
                                >
                                    changed since {r.uploaded.name} went up
                                </Text>
                            )}
                        </>
                    }
                    meta={status}
                    actions={
                        <Menu
                            placement="bottom-end"
                            items={rowMenu(recording)}
                            trigger={<IconButton icon="more-horizontal" size="sm" label="More" />}
                        />
                    }
                    onClick={(event) => {
                        if (picking) {
                            toggle(recording.id, event.shiftKey)
                        } else {
                            select(recording.id)
                        }
                    }}
                />
            </ContextMenu>
        )
    }

    const active = (tray?.uploads ?? []).filter((u) => u.state === "queued" || u.state === "uploading").length
    const total = everything.reduce((sum, r) => sum + r.size, 0)
    const free = drives?.destination.free ?? null
    const capacity = drives?.destination.total ?? null
    const sortLabel = SORTS.find((s) => s.key === sort && s.order === order)?.label ??
        `${sort} ${order}`
    const inspectorActions = (recording: Recording): InspectorActions => ({
        replay: () => open(recording, "replayer"),
        rename: () => rename(recording),
        upload: () => upload([recording]),
        reupload: () => reupload(recording),
        remove: () => setDeleting([recording]),
        opens: opensMenu(recording),
        more: moreMenu(recording),
    })

    return (
        <div
            className={`rec-library ${phone && showDetail && current ? "rec-show-detail" : ""}`}
        >
            <aside className="rec-list" aria-label="Recordings">
                <header className="rec-list-head">
                    <div className="rec-row-flex">
                        {/* inside Desktop, its window bar already names the app, so the buttons start the row */}
                        {globalThis.parent === globalThis.self && <Text className="rec-title">Recordings</Text>}
                        <span className="rec-grow" />
                        {onDrives > 0 && (
                            <Button
                                size="sm"
                                variant="primary"
                                icon="download"
                                data-testid="transfer-button"
                                title={`recordings on ${drives?.drives.map((d) => d.name).join(", ")}`}
                                onClick={() => go({ view: "library", transfer: true })}
                            >
                                Transfer · {onDrives}
                            </Button>
                        )}
                        <Button
                            size="sm"
                            icon="upload"
                            pressed={trayOpen}
                            data-testid="uploads-button"
                            onClick={() => setTrayOpen(!trayOpen)}
                        >
                            Uploads{active ? ` · ${active}` : ""}
                        </Button>
                    </div>
                    <SearchInput
                        value={query}
                        onChange={setQuery}
                        placeholder="Search names, notes, topics…"
                        data-testid="search"
                    />
                    <div className="rec-row-flex">
                        <Chip
                            selected={!onlyWarnings}
                            onChange={() => setOnlyWarnings(false)}
                        >
                            All
                        </Chip>
                        <Chip
                            selected={onlyWarnings}
                            tone="warn"
                            icon="warn"
                            title="only the recordings with warnings"
                            onChange={() => setOnlyWarnings(!onlyWarnings)}
                        >
                            {flagged}
                        </Chip>
                        <span className="rec-grow" />
                        <Menu
                            placement="bottom-end"
                            items={SORTS.map((s) => ({
                                label: s.label,
                                checked: s.key === sort && s.order === order,
                                onSelect: () => setSorting({ sort: s.key, order: s.order }),
                            }))}
                            trigger={
                                <Button size="sm" variant="ghost" iconRight="chevron-down">
                                    {sortLabel}
                                </Button>
                            }
                        />
                    </div>
                </header>
                {error && (
                    <Alert tone="warn" data-testid="onboard-backend-down">
                        The Recordings server isn't answering ({error}). It retries by itself; if this stays, close the
                        app (✕) and open it again.
                    </Alert>
                )}
                <div className="rec-items">
                    {sections.map((section, index) => (
                        <section key={section.label ?? index}>
                            {section.label && (
                                <div className="rec-group">
                                    <Text className="rec-group-label">{section.label}</Text>
                                    <Text small muted mono>
                                        {section.recordings.length} · {bytes(
                                            section.recordings.reduce((sum, r) => sum + r.size, 0),
                                        )}
                                    </Text>
                                </div>
                            )}
                            {section.recordings.map((recording) => row(recording, section.label))}
                        </section>
                    ))}
                    {data && everything.length > 0 && !shown.length && <Text small muted>Nothing matches.</Text>}
                    {data && !everything.length && (
                        <EmptyState
                            icon="record"
                            title="You don't have any recordings yet"
                            message={`Record a robot with the Controller app: run a blueprint (or a replay), open the Controller's Record tab and press Record. New recordings in ${data.dir} show up here by themselves.`}
                            data-testid="onboard-no-recordings"
                            actions={
                                <>
                                    <Button
                                        variant="primary"
                                        onClick={() => openApp("dim-controller")}
                                    >
                                        Record with the Controller
                                    </Button>
                                    <Button onClick={() => openApp("launcher")}>
                                        Open the Launcher
                                    </Button>
                                </>
                            }
                        />
                    )}
                </div>
                {picking
                    ? (
                        <footer className="rec-list-foot rec-row-flex" data-testid="selbar">
                            <Text>
                                {picking.ids.size} selected{" "}
                                <Text small muted mono>
                                    {bytes(pickedItems.reduce((sum, r) => sum + r.size, 0))}
                                </Text>
                            </Text>
                            <span className="rec-grow" />
                            <Button
                                size="sm"
                                icon="upload"
                                disabled={!pickedRecordings.length}
                                onClick={() => upload(pickedRecordings).then(() => setPicking(null))}
                            >
                                Upload
                            </Button>
                            <Button
                                size="sm"
                                variant="danger"
                                icon="trash"
                                disabled={!pickedItems.length}
                                onClick={() => setDeleting(pickedItems)}
                            >
                                Delete
                            </Button>
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setPicking(null)}
                            >
                                Cancel
                            </Button>
                        </footer>
                    )
                    : (
                        <footer className="rec-list-foot">
                            <div className="rec-row-flex">
                                <Text small muted mono>
                                    {everything.length} {everything.length === 1 ? "recording" : "recordings"} ·{" "}
                                    {bytes(total)}
                                </Text>
                                <span className="rec-grow" />
                                {free !== null && <Text small muted mono>{bytes(free)} free</Text>}
                            </div>
                            {free !== null && capacity
                                ? (
                                    <Progress
                                        value={(capacity - free) / capacity}
                                        label={data?.dir}
                                    />
                                )
                                : null}
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
                    />
                )
                : current
                ? (
                    <section className="rec-detail" data-testid="inspector">
                        <EmptyState
                            icon="file"
                            title={current.name}
                            message={`a Rerun recording · ${bytes(current.size)}`}
                            actions={
                                <>
                                    <Button
                                        variant="primary"
                                        disabled={!current.opens[0]?.ok}
                                        title={current.opens[0]?.reason}
                                        onClick={() => open(current, "rerun")}
                                    >
                                        Open in Rerun
                                    </Button>
                                    <Button
                                        variant="danger"
                                        icon="trash"
                                        onClick={() => setDeleting([current])}
                                    >
                                        Delete
                                    </Button>
                                </>
                            }
                        />
                    </section>
                )
                : <section className="rec-detail" />}
            {trayOpen && (
                <UploadTray
                    tray={tray}
                    error={trayError}
                    onChange={refreshTray}
                    onClose={() => setTrayOpen(false)}
                />
            )}
            {transfer && <TransferDialog onClose={() => go({ view: "library" })} />}
            <Modal
                open={!!deleting}
                size="sm"
                title={deleting?.length === 1 ? "Delete recording" : `Delete ${deleting?.length ?? 0} recordings`}
                onClose={() => setDeleting(null)}
                footer={
                    <>
                        <Button onClick={() => setDeleting(null)}>Cancel</Button>
                        <Button
                            variant="danger"
                            autoFocus
                            onClick={() => {
                                remove(deleting ?? [])
                                setDeleting(null)
                            }}
                        >
                            Delete
                        </Button>
                    </>
                }
            >
                <Text as="p">
                    {bytes((deleting ?? []).reduce((sum, r) => sum + r.size, 0))} will be removed from{" "}
                    <Text mono>{data?.dir}</Text>.
                    {(deleting ?? []).some((r) => r.symlink)
                        ? " Links go, not the files they point to."
                        : " This can't be undone."}
                </Text>
                <div className="rec-names" data-testid="delete-names">
                    {(deleting ?? []).map((r) => <Text key={r.id} as="div" small mono>{r.name}</Text>)}
                </div>
            </Modal>
        </div>
    )
}

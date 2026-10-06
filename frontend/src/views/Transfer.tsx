// The transfer dialog (#/transfer, where Desktop's "Transfer recordings" notification lands): the recordings on each
// plugged-in drive with their previews, size and date, to copy or move into the recordings folder (one at a time or
// ticked together) or rename on the drive. Never overwrites; says when there isn't room.
import { useEffect, useState } from "react"
import { api, bytes, type DriveFile, type DrivesResponse, type Transfer } from "../api.ts"
import { appEvents } from "../dim-app/events.js"
import { useBackendState } from "../dim-app/react.js"
import { ConfirmDialog, RenameDialog, Thumbnail, toast } from "../ui.tsx"

const fail = (error: unknown) => toast(String((error as Error)?.message ?? error), "danger")

function date(seconds: number) {
    return new Date(seconds * 1000).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
    })
}

type Pending = { kind: "move"; files: DriveFile[] } | { kind: "rename"; file: DriveFile } | null

export function TransferDialog({ onClose }: { onClose: () => void }) {
    const [data, { refresh }] = useBackendState<DrivesResponse>("api/drives", { key: "drives" })
    const [live, setLive] = useState<Record<string, Transfer>>({})
    const [picked, setPicked] = useState<Set<string>>(new Set())
    const [pending, setPending] = useState<Pending>(null)
    const [version, setVersion] = useState(1)

    // progress arrives as events (the list itself is re-read when one finishes)
    useEffect(() =>
        appEvents((event) => {
            if (event.type === "transfer") {
                const transfer = event.transfer as Transfer
                setLive((current) => ({ ...current, [transfer.id]: transfer }))
                if (transfer.state === "done") {
                    toast(`${transfer.mode === "move" ? "moved" : "copied"} ${transfer.result}`, "ok")
                } else if (transfer.state === "failed") {
                    toast(`${transfer.name}: ${transfer.error}`, "danger")
                }
            } else if (event.type === "thumbnail") {
                setVersion((v) => v + 1)
            }
        }), [])
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => event.key === "Escape" && !pending && onClose()
        addEventListener("keydown", onKey)
        return () => removeEventListener("keydown", onKey)
    }, [onClose, pending])

    const transfers = new Map<string, Transfer>()
    for (const transfer of [...(data?.transfers ?? []), ...Object.values(live)]) {
        const known = transfers.get(transfer.source)
        // the newest transfer of each file (ids count up)
        if (!known || Number(transfer.id.slice(1)) >= Number(known.id.slice(1))) {
            transfers.set(transfer.source, transfer)
        }
    }
    const files = data?.drives.flatMap((drive) => drive.files) ?? []
    const chosen = files.filter((file) => picked.has(file.path))
    const needed = chosen.reduce((sum, file) => sum + file.size, 0)
    const free = data?.destination.free ?? null
    const busy = (file: DriveFile) => ["queued", "running"].includes(transfers.get(file.path)?.state ?? "")

    const start = (list: DriveFile[], mode: "copy" | "move") => {
        api.transfer(list.map((file) => file.path), mode).then(({ transfers }) => {
            setLive((current) => ({ ...current, ...Object.fromEntries(transfers.map((t) => [t.id, t])) }))
            setPicked(new Set())
        }, fail)
    }
    const toggle = (path: string) =>
        setPicked((current) => {
            const next = new Set(current)
            next.has(path) ? next.delete(path) : next.add(path)
            return next
        })

    const status = (file: DriveFile) => {
        const transfer = transfers.get(file.path)
        if (!transfer) {
            return null
        }
        if (transfer.state === "running" || transfer.state === "queued") {
            const fraction = transfer.total ? transfer.done / transfer.total : 0
            return (
                <div className="transfer-progress">
                    <div className={`dim-progress ${transfer.state === "queued" ? "indeterminate" : ""}`}>
                        <span style={{ width: `${Math.max(3, fraction * 100)}%` }} />
                    </div>
                    <span className="small muted mono">
                        {transfer.state === "queued"
                            ? "waiting…"
                            : `${bytes(transfer.done)} of ${bytes(transfer.total)}`}
                    </span>
                    <button
                        type="button"
                        className="dim-btn ghost sm"
                        onClick={() => api.cancelTransfer(transfer.id).catch(fail)}
                    >
                        ✕
                    </button>
                </div>
            )
        }
        return (
            <span className={`small transfer-state ${transfer.state}`}>
                {transfer.state === "done"
                    ? `${transfer.mode === "move" ? "moved" : "copied"} as ${transfer.result}`
                    : transfer.state === "failed"
                    ? `failed: ${transfer.error}`
                    : "cancelled"}
            </span>
        )
    }

    return (
        <div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
            <div className="dialog dim-card transfer-dialog" role="dialog" aria-label="Transfer recordings">
                <div className="transfer-head">
                    <p className="section-head">Transfer recordings</p>
                    <div className="spacer" />
                    <button
                        type="button"
                        className="dim-btn ghost sm"
                        onClick={() => api.rescanDrives().then(() => refresh(), fail)}
                    >
                        Rescan
                    </button>
                    <button type="button" className="dim-btn ghost sm" onClick={onClose} aria-label="close">
                        ✕
                    </button>
                </div>
                <p className="small muted">
                    Into <span className="mono">{data?.destination.dir}</span>
                    {free !== null && <>· {bytes(free)} free</>}
                </p>
                {data && !data.drives.length && (
                    <p className="transfer-empty muted">
                        No drive with recordings is plugged in. Plug in a USB drive or SD card with .mcap or .db
                        recordings on it; it shows up here within a few seconds.
                    </p>
                )}
                <div className="transfer-list">
                    {data?.drives.map((drive) => (
                        <section key={drive.mount} className="transfer-drive">
                            <h3 className="group-head">
                                {drive.name}
                                <span className="muted small mono">
                                    {drive.mount} · {drive.files.length} recording{drive.files.length === 1 ? "" : "s"}
                                    {drive.free !== null && ` · ${bytes(drive.free)} free`}
                                </span>
                            </h3>
                            {drive.files.map((file) => (
                                <div
                                    key={file.path}
                                    className={`transfer-row ${picked.has(file.path) ? "picked" : ""}`}
                                    data-testid={`transfer-${file.relative}`}
                                >
                                    <input
                                        type="checkbox"
                                        aria-label={`pick ${file.name}`}
                                        checked={picked.has(file.path)}
                                        disabled={busy(file)}
                                        onChange={() => toggle(file.path)}
                                    />
                                    <Thumbnail
                                        id={file.path}
                                        thumb={file.thumbnail}
                                        version={version}
                                        src={api.driveThumbnailUrl(file.path, version)}
                                    />
                                    <div className="transfer-name">
                                        <span className="mono">{file.name}</span>
                                        <span className="small muted mono">
                                            {file.relative.includes("/")
                                                ? file.relative.slice(0, file.relative.lastIndexOf("/") + 1)
                                                : ""}
                                            {bytes(file.size)} · {date(file.modified)}
                                        </span>
                                        {status(file)}
                                    </div>
                                    <div className="transfer-actions">
                                        <button
                                            type="button"
                                            className="dim-btn sm primary"
                                            disabled={busy(file)}
                                            onClick={() => start([file], "copy")}
                                        >
                                            Copy
                                        </button>
                                        <button
                                            type="button"
                                            className="dim-btn sm"
                                            disabled={busy(file)}
                                            onClick={() => setPending({ kind: "move", files: [file] })}
                                        >
                                            Move
                                        </button>
                                        <button
                                            type="button"
                                            className="dim-btn sm"
                                            disabled={busy(file)}
                                            onClick={() => setPending({ kind: "rename", file })}
                                        >
                                            Rename
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </section>
                    ))}
                </div>
                {files.length > 0 && (
                    <div className="transfer-foot">
                        <label className="small">
                            <input
                                type="checkbox"
                                checked={chosen.length > 0 && chosen.length === files.filter((f) => !busy(f)).length}
                                onChange={(event) =>
                                    setPicked(
                                        new Set(
                                            event.target.checked
                                                ? files.filter((f) => !busy(f)).map((f) => f.path)
                                                : [],
                                        ),
                                    )}
                            />{" "}
                            all
                        </label>
                        <span className="small muted">
                            {chosen.length
                                ? `${chosen.length} picked · ${bytes(needed)}`
                                : "tick recordings to copy or move several"}
                        </span>
                        {free !== null && needed > free && (
                            <span className="small transfer-state failed">not enough room ({bytes(free)} free)</span>
                        )}
                        <div className="spacer" />
                        <button
                            type="button"
                            className="dim-btn sm"
                            disabled={!chosen.length || (free !== null && needed > free)}
                            onClick={() => setPending({ kind: "move", files: chosen })}
                        >
                            Move {chosen.length || ""}
                        </button>
                        <button
                            type="button"
                            className="dim-btn sm primary"
                            disabled={!chosen.length || (free !== null && needed > free)}
                            onClick={() => start(chosen, "copy")}
                        >
                            Copy {chosen.length || ""}
                        </button>
                    </div>
                )}
            </div>
            {pending?.kind === "move" && (
                <ConfirmDialog
                    title="Move"
                    action="Move"
                    body={
                        <p>
                            Copy {pending.files.length === 1
                                ? <span className="mono">{pending.files[0].name}</span>
                                : `${pending.files.length} recordings`}{" "}
                            ({bytes(pending.files.reduce((sum, file) => sum + file.size, 0))}) into the recordings
                            folder, then delete {pending.files.length === 1 ? "it" : "them"}{" "}
                            from the drive once the copy is checked.
                        </p>
                    }
                    onClose={() => setPending(null)}
                    onConfirm={() => start(pending.files, "move")}
                />
            )}
            {pending?.kind === "rename" && (
                <RenameDialog
                    name={pending.file.name}
                    onClose={() => setPending(null)}
                    onRename={(name) =>
                        api.renameOnDrive(pending.file.path, name).then(
                            (r) => {
                                toast(`renamed to ${r.name}`, "ok")
                                refresh()
                            },
                            fail,
                        )}
                />
            )}
        </div>
    )
}

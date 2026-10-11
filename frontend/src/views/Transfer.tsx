// The transfer dialog (#/transfer, where Desktop's "Transfer recordings" notification lands): the recordings on each
// plugged-in drive with their previews, size and date, to copy or move into the recordings folder (one at a time or
// ticked together) or rename on the drive. Never overwrites; says when there isn't room.
import { useState } from "react"
import {
    Alert,
    Button,
    Checkbox,
    Heading,
    IconButton,
    Modal,
    Progress,
    Text,
    toast,
    useBackendEvents,
    useBackendState,
    useConfirm,
    usePrompt,
} from "dimos-react"
import { api, bytes, type DriveFile, type DrivesResponse, type Transfer } from "../api.ts"
import { Thumbnail } from "./Thumbnail.tsx"

const fail = (error: unknown) => toast.error(String((error as Error)?.message ?? error))

function date(seconds: number) {
    return new Date(seconds * 1000).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
    })
}

export function TransferDialog({ onClose }: { onClose: () => void }) {
    const [data, { refresh }] = useBackendState("drives", {
        url: "api/drives",
    }) as [
        DrivesResponse | undefined,
        { refresh: () => Promise<void> },
    ]
    const [live, setLive] = useState<Record<string, Transfer>>({})
    const [picked, setPicked] = useState<Set<string>>(new Set())
    const [version, setVersion] = useState(1)
    const confirm = useConfirm()
    const prompt = usePrompt()

    // progress arrives as events (the list itself is re-read when one finishes)
    useBackendEvents((event: { type?: string; transfer?: Transfer }) => {
        if (event.type === "transfer" && event.transfer) {
            const transfer = event.transfer
            setLive((current) => ({ ...current, [transfer.id]: transfer }))
            if (transfer.state === "done") {
                toast.ok(
                    `${transfer.mode === "move" ? "moved" : "copied"} ${transfer.result}`,
                )
            } else if (transfer.state === "failed") {
                toast.error(`${transfer.name}: ${transfer.error}`)
            }
        } else if (event.type === "thumbnail") {
            setVersion((v) => v + 1)
        }
    })

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
    const idle = files.filter((f) => !busy(f))

    const start = (list: DriveFile[], mode: "copy" | "move") => {
        api.transfer(list.map((file) => file.path), mode).then(({ transfers }) => {
            setLive((current) => ({
                ...current,
                ...Object.fromEntries(transfers.map((t) => [t.id, t])),
            }))
            setPicked(new Set())
        }, fail)
    }
    const move = async (list: DriveFile[]) => {
        const sure = await confirm({
            title: "Move",
            confirmLabel: "Move",
            message: `Copy ${list.length === 1 ? list[0].name : `${list.length} recordings`} (${
                bytes(list.reduce((sum, file) => sum + file.size, 0))
            }) into the recordings folder, then delete ${
                list.length === 1 ? "it" : "them"
            } from the drive once the copy is checked.`,
        })
        if (sure) {
            start(list, "move")
        }
    }
    const rename = async (file: DriveFile) => {
        const dot = file.name.lastIndexOf(".")
        const extension = dot > 0 ? file.name.slice(dot) : ""
        const base = (await prompt({
            title: `Rename ${file.name}`,
            defaultValue: dot > 0 ? file.name.slice(0, dot) : file.name,
            confirmLabel: "Rename",
        }))?.trim()
        if (base && base + extension !== file.name) {
            api.renameOnDrive(file.path, base + extension).then((r) => {
                toast.ok(`renamed to ${r.name}`)
                refresh()
            }, fail)
        }
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
                <div className="rec-row-flex">
                    <Progress
                        value={transfer.state === "queued" ? undefined : Math.max(0.03, fraction)}
                        className="rec-grow"
                    />
                    <Text small muted mono>
                        {transfer.state === "queued"
                            ? "waiting…"
                            : `${bytes(transfer.done)} of ${bytes(transfer.total)}`}
                    </Text>
                    <IconButton
                        icon="close"
                        size="sm"
                        label="Cancel"
                        onClick={() => api.cancelTransfer(transfer.id).catch(fail)}
                    />
                </div>
            )
        }
        return (
            <Text
                small
                tone={transfer.state === "done" ? "ok" : transfer.state === "failed" ? "danger" : undefined}
            >
                {transfer.state === "done"
                    ? `${transfer.mode === "move" ? "moved" : "copied"} as ${transfer.result}`
                    : transfer.state === "failed"
                    ? `failed: ${transfer.error}`
                    : "cancelled"}
            </Text>
        )
    }

    return (
        <Modal
            open
            size="lg"
            title="Transfer recordings"
            onClose={onClose}
            aria-label="Transfer recordings"
            footer={files.length > 0
                ? (
                    <div className="rec-row-flex rec-transfer-foot">
                        <Checkbox
                            value={chosen.length > 0 && chosen.length === idle.length}
                            label="all"
                            onChange={(on: boolean) => setPicked(new Set(on ? idle.map((f) => f.path) : []))}
                        />
                        <Text small muted>
                            {chosen.length
                                ? `${chosen.length} picked · ${bytes(needed)}`
                                : "tick recordings to copy or move several"}
                        </Text>
                        {free !== null && needed > free && (
                            <Text small tone="danger">
                                not enough room ({bytes(free)} free)
                            </Text>
                        )}
                        <span className="rec-grow" />
                        <Button
                            disabled={!chosen.length || (free !== null && needed > free)}
                            onClick={() => move(chosen)}
                        >
                            Move {chosen.length || ""}
                        </Button>
                        <Button
                            variant="primary"
                            disabled={!chosen.length || (free !== null && needed > free)}
                            onClick={() => start(chosen, "copy")}
                        >
                            Copy {chosen.length || ""}
                        </Button>
                    </div>
                )
                : undefined}
        >
            <div className="rec-row-flex">
                <Text small muted>
                    Into <Text mono>{data?.destination.dir}</Text>
                    {free !== null && ` · ${bytes(free)} free`}
                </Text>
                <span className="rec-grow" />
                <Button
                    size="sm"
                    variant="ghost"
                    icon="refresh"
                    onClick={() => api.rescanDrives().then(() => refresh(), fail)}
                >
                    Rescan
                </Button>
            </div>
            {data && !data.drives.length && (
                <Text muted as="p">
                    No drive with recordings is plugged in. Plug in a USB drive or SD card with .mcap or .db recordings
                    on it; it shows up here within a few seconds.
                </Text>
            )}
            <div className="rec-transfer-list">
                {data?.drives.map((drive) => (
                    <section key={drive.mount}>
                        <Heading level={3} className="rec-row-flex">
                            {drive.name}
                            <Text small muted mono>
                                {drive.state === "not-responding"
                                    ? drive.mount
                                    : `${drive.mount} · ${drive.files.length} recording${
                                        drive.files.length === 1 ? "" : "s"
                                    }`}
                                {drive.free !== null && ` · ${bytes(drive.free)} free`}
                            </Text>
                        </Heading>
                        {drive.state === "not-responding" && (
                            <Alert tone="warn" data-drive-stuck>
                                Not responding. If macOS is asking on this Mac whether to allow access to the drive,
                                answer it there; the list fills in once it does.
                            </Alert>
                        )}
                        {drive.files.map((file) => (
                            <div
                                key={file.path}
                                className="rec-transfer-row"
                                data-testid={`transfer-${file.relative}`}
                            >
                                <Checkbox
                                    aria-label={`pick ${file.name}`}
                                    value={picked.has(file.path)}
                                    disabled={busy(file)}
                                    onChange={() => toggle(file.path)}
                                />
                                <Thumbnail
                                    id={file.path}
                                    thumb={file.thumbnail}
                                    version={version}
                                    src={api.driveThumbnailUrl(file.path, version)}
                                />
                                <div className="rec-transfer-name">
                                    <Text mono>{file.name}</Text>
                                    <Text small muted mono>
                                        {file.relative.includes("/")
                                            ? `${
                                                file.relative.slice(
                                                    0,
                                                    file.relative.lastIndexOf("/") + 1,
                                                )
                                            } · `
                                            : ""}
                                        {bytes(file.size)} · {date(file.modified)}
                                    </Text>
                                    {status(file)}
                                </div>
                                <div className="rec-row-flex">
                                    <Button
                                        size="sm"
                                        variant="primary"
                                        disabled={busy(file)}
                                        onClick={() => start([file], "copy")}
                                    >
                                        Copy
                                    </Button>
                                    <Button
                                        size="sm"
                                        disabled={busy(file)}
                                        onClick={() => move([file])}
                                    >
                                        Move
                                    </Button>
                                    <Button
                                        size="sm"
                                        disabled={busy(file)}
                                        onClick={() => rename(file)}
                                    >
                                        Rename
                                    </Button>
                                </div>
                            </div>
                        ))}
                    </section>
                ))}
            </div>
        </Modal>
    )
}

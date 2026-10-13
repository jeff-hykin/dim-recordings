// Uploads to the Dimensional cloud: the tray (state, elapsed time, progress only when real numbers arrive,
// cancel/retry). The login isn't this app's: it is Desktop's (Settings → Dimensional account), shared by every app.
import { useEffect, useState } from "react"
import { Alert, Button, FloatingPanel, IconButton, Progress, Text, useBackendState, useZenoh } from "dimos-react"
import { api, bytes, type Tray, type Upload } from "../api.ts"
import { openApp } from "../dim-app/source/desktop.js"

const PHASES: Record<string, string> = {
    preparing: "preparing",
    compress: "compressing",
    hash: "checksumming",
    upload: "uploading",
    finishing: "finishing",
}

function eta(seconds: number | null) {
    if (seconds === null) {
        return ""
    }
    return seconds < 60 ? `${Math.ceil(seconds)} s left` : `${Math.ceil(seconds / 60)} min left`
}

/** The tray's state (GET api/uploads): re-read when the backend says it changed (frontend topic state/uploads) and
 * on the dimos server's upload events (`<ns>/dimos/events/upload*`, `cloud-login`), at most every 250 ms. */
export function useTray() {
    const [tray, { error, refresh }] = useBackendState("uploads", {
        url: "api/uploads",
        debounceMs: 250,
    }) as [
        Tray | undefined,
        { error: Error | null; refresh: () => Promise<void> },
    ]
    const zenoh = useZenoh()
    useEffect(() => {
        if (!zenoh) {
            return
        }
        let timer: ReturnType<typeof setTimeout> | undefined
        const off = zenoh.subscribeDimos("*", (event: { type?: string }) => {
            if (
                ["upload", "uploads", "upload-removed", "cloud-login"].includes(
                    event?.type ?? "",
                ) && !timer
            ) {
                timer = setTimeout(() => {
                    timer = undefined
                    refresh()
                }, 250)
            }
        })
        return () => {
            off()
            clearTimeout(timer)
        }
    }, [zenoh, refresh])
    return {
        tray: tray ?? null,
        error: error ? String(error.message ?? error) : null,
        refresh: () => void refresh(),
    }
}

/** Desktop's Settings → Dimensional account, where every app's cloud login lives; signing in there brings the user
 * back here (the shell returns to the app that opened Settings). */
export function openCloudLogin() {
    return openApp("settings", { path: "settings-cloud-account" })
}

// when this page first saw each upload running: the elapsed time is what an upload without progress can honestly show
const startedAt = new Map<string, number>()

/** "42 s", "3 min 05 s", "1 h 02 min" */
function elapsed(seconds: number) {
    const s = Math.floor(seconds)
    if (s < 60) {
        return `${s} s`
    }
    if (s < 3600) {
        return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`
    }
    return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")} min`
}

/** The real fraction sent, or null: dimos's upload reports bytes only per part (or not at all), so 0 bytes done means
 * "unknown", not "nothing sent", and the bar stays indeterminate until a real count arrives. */
export function uploadFraction(upload: Upload): number | null {
    return upload.bytesTotal > 0 && upload.bytesDone > 0 ? Math.min(1, upload.bytesDone / upload.bytesTotal) : null
}

function Row(
    { upload, waitingForLogin, onChange }: {
        upload: Upload
        waitingForLogin: boolean
        onChange: () => void
    },
) {
    const running = upload.state === "uploading" || upload.state === "queued"
    const fraction = uploadFraction(upload)
    const [now, setNow] = useState(Date.now())
    if (upload.state === "uploading" && !startedAt.has(upload.id)) {
        startedAt.set(upload.id, Date.now())
    }
    useEffect(() => {
        if (upload.state !== "uploading") {
            return
        }
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
    }, [upload.state])
    const since = startedAt.has(upload.id) ? (now - startedAt.get(upload.id)!) / 1000 : 0
    const status = upload.state === "uploading"
        ? `${PHASES[upload.phase ?? ""] ?? upload.phase ?? "uploading"}${
            fraction !== null ? ` ${Math.round(fraction * 100)}%` : "…"
        } · ${elapsed(since)}` +
            (fraction !== null && upload.rateBps ? ` · ${bytes(upload.rateBps)}/s` : "") +
            (fraction !== null && upload.etaSeconds !== null ? ` · ${eta(upload.etaSeconds)}` : "")
        : upload.state === "failed"
        ? upload.error ?? "failed"
        : upload.state === "queued" && waitingForLogin
        ? "waiting for login"
        : upload.state
    return (
        <div className="rec-upload" data-state={upload.state}>
            <div className="rec-row-flex">
                <Text mono small className="rec-grow">{upload.name}</Text>
                <Text mono small muted>{bytes(upload.size)}</Text>
            </div>
            {running && <Progress value={fraction ?? undefined} />}
            <div className="rec-row-flex">
                <Text
                    small
                    muted={upload.state !== "failed"}
                    tone={upload.state === "failed" ? "danger" : undefined}
                    className="rec-grow"
                >
                    {status}
                </Text>
                {upload.state === "done" && upload.link && (
                    <Button
                        size="sm"
                        variant="primary"
                        iconRight="external"
                        onClick={() => globalThis.open(upload.link!, "_blank", "noreferrer")}
                    >
                        View
                    </Button>
                )}
                {(upload.state === "failed" || upload.state === "cancelled") && (
                    <Button
                        size="sm"
                        icon="refresh"
                        onClick={() => api.retryUpload(upload.id).then(onChange)}
                    >
                        Retry
                    </Button>
                )}
                {running
                    ? (
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => api.removeUpload(upload.id).then(onChange)}
                        >
                            Cancel
                        </Button>
                    )
                    : (
                        <IconButton
                            icon="close"
                            size="sm"
                            label="remove from the tray"
                            onClick={() => api.removeUpload(upload.id).then(onChange)}
                        />
                    )}
            </div>
        </div>
    )
}

export function UploadTray(
    { tray, error, onChange, onClose }: {
        tray: Tray | null
        error: string | null
        onChange: () => void
        onClose: () => void
    },
) {
    return (
        <FloatingPanel
            className="rec-tray"
            title="Uploads"
            icon="upload"
            width={380}
            defaultPosition={{ x: -16, y: 56 }}
            actions={
                <Text small muted>
                    {tray?.account.loggedIn ? tray.account.email ?? "logged in" : "not logged in"}
                </Text>
            }
            onClose={onClose}
            aria-label="Uploads"
        >
            <div className="rec-tray-body">
                {error && <Alert tone="danger">{error}</Alert>}
                {tray && !tray.account.loggedIn && (
                    <Alert
                        tone="info"
                        data-testid="onboard-login"
                        actions={
                            <Button size="sm" variant="primary" onClick={openCloudLogin}>
                                Log in
                            </Button>
                        }
                    >
                        Not logged in to Dimensional cloud. Uploads wait here until you log in, in Desktop's Settings.
                    </Alert>
                )}
                {!tray?.uploads.length && (
                    <Text small muted as="p">
                        Nothing uploading. Use a recording's Upload button to send it to your Dimensional account.
                    </Text>
                )}
                {tray?.uploads.slice().reverse().map((upload) => (
                    <Row
                        key={upload.id}
                        upload={upload}
                        waitingForLogin={!!tray &&
                            (tray.waitingForLogin || !tray.account.loggedIn)}
                        onChange={onChange}
                    />
                ))}
            </div>
        </FloatingPanel>
    )
}

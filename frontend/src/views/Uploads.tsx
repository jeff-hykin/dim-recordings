// Uploads to the Dimensional cloud: the tray (progress, phase, ETA, cancel/retry) and the login panel, which is
// Desktop's own page in an iframe (`/dimos/cloud/login/page`, NosyPuma upload_api.md).
import { useEffect, useRef, useState } from "react"
import { api, bytes, desktopPath, type Tray, type Upload } from "../api.ts"
import { isDark } from "../dim-app/theme.js"
import { useBackendState } from "../dim-app/react.js"
import { getZenoh } from "../dim-app/zenoh.js"

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
    const [tray, { error, refresh }] = useBackendState<Tray>("api/uploads", { key: "uploads", debounceMs: 250 })
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const off = getZenoh().subscribeDimos("*", (event: { type?: string }) => {
            if (["upload", "uploads", "upload-removed", "cloud-login"].includes(event?.type ?? "") && !timer) {
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
    }, [refresh])
    return { tray: tray ?? null, error: error ? String(error.message ?? error) : null, refresh: () => void refresh() }
}

export function LoginPanel(
    { onDone, onClose }: { onDone: () => void; onClose: () => void },
) {
    useEffect(() => {
        const onMessage = (event: MessageEvent) => {
            if (
                event.data?.type === "dimos-cloud-login" &&
                ["approved", "loggedIn"].includes(event.data.state)
            ) {
                onDone()
            }
        }
        addEventListener("message", onMessage)
        return () => removeEventListener("message", onMessage)
    }, [onDone])
    // The page is same-origin (Desktop serves both), so the frame follows its content's height in every state
    const frame = useRef<HTMLIFrameElement>(null)
    const [height, setHeight] = useState<number | null>(null)
    useEffect(() => {
        const element = frame.current
        if (!element) {
            return
        }
        let observer: ResizeObserver | null = null
        const follow = () => {
            observer?.disconnect()
            try {
                const root = element.contentDocument?.documentElement
                if (!root) {
                    return
                }
                observer = new ResizeObserver(() => setHeight(Math.ceil(root.getBoundingClientRect().height)))
                observer.observe(root)
            } catch {
                // not same-origin: keep the CSS height
            }
        }
        element.addEventListener("load", follow)
        if (element.contentDocument?.readyState === "complete" && element.contentDocument.URL !== "about:blank") {
            follow()
        }
        return () => {
            element.removeEventListener("load", follow)
            observer?.disconnect()
        }
    }, [])
    return (
        <div className="login">
            <p className="small muted">
                Log in to the Dimensional cloud to upload. The upload waits until you do.
            </p>
            <iframe
                ref={frame}
                title="Dimensional login"
                style={height ? { height: height + 2 } : undefined}
                src={desktopPath(
                    `dimos/cloud/login/page?theme=${isDark() ? "dark" : "light"}`,
                )}
            />
            <button type="button" className="dim-btn ghost sm" onClick={onClose}>
                Close
            </button>
        </div>
    )
}

function Row(
    { upload, waitingForLogin, onChange }: { upload: Upload; waitingForLogin: boolean; onChange: () => void },
) {
    const running = upload.state === "uploading" || upload.state === "queued"
    const fraction = upload.bytesTotal > 0 ? upload.bytesDone / upload.bytesTotal : null
    return (
        <div className={`upload ${upload.state}`} data-state={upload.state}>
            <div className="upload-top">
                <span className="mono name">{upload.name}</span>
                <span className="mono muted small">{bytes(upload.size)}</span>
            </div>
            {running && (
                <div
                    className={`dim-progress ${fraction === null ? "indeterminate" : ""}`}
                >
                    <span style={{ width: `${(fraction ?? 0.3) * 100}%` }} />
                </div>
            )}
            <div className="upload-bottom small">
                <span className={upload.state === "failed" ? "error" : "muted"}>
                    {upload.state === "uploading"
                        ? `${PHASES[upload.phase ?? ""] ?? upload.phase ?? ""} ${
                            fraction !== null ? `${Math.round(fraction * 100)}%` : ""
                        }`
                        : upload.state === "failed"
                        ? upload.error ?? "failed"
                        : upload.state === "queued" && waitingForLogin
                        ? "waiting for login"
                        : upload.state}
                    {upload.state === "uploading" && upload.rateBps ? ` · ${bytes(upload.rateBps)}/s` : ""}
                    {upload.state === "uploading" && upload.etaSeconds !== null ? ` · ${eta(upload.etaSeconds)}` : ""}
                </span>
                <span className="upload-actions">
                    {upload.state === "done" && upload.link && (
                        <a
                            className="dim-btn sm primary"
                            href={upload.link}
                            target="_blank"
                            rel="noreferrer"
                        >
                            View ↗
                        </a>
                    )}
                    {(upload.state === "failed" || upload.state === "cancelled") && (
                        <button
                            type="button"
                            className="dim-btn sm"
                            onClick={() => api.retryUpload(upload.id).then(onChange)}
                        >
                            Retry
                        </button>
                    )}
                    <button
                        type="button"
                        className="dim-btn sm ghost"
                        title={running ? "cancel" : "remove from the tray"}
                        onClick={() => api.removeUpload(upload.id).then(onChange)}
                    >
                        {running ? "Cancel" : "✕"}
                    </button>
                </span>
            </div>
        </div>
    )
}

export function UploadTray(
    { tray, error, login, onLogin, onCloseLogin, onChange, onClose }: {
        tray: Tray | null
        error: string | null
        login: boolean
        onLogin: () => void
        onCloseLogin: () => void
        onChange: () => void
        onClose: () => void
    },
) {
    return (
        <aside className="tray dim-card" aria-label="Uploads">
            <header>
                <p className="section-head">Uploads</p>
                <span className="small muted">
                    {tray?.account.loggedIn ? tray.account.email ?? "logged in" : "not logged in"}
                </span>
                <button
                    type="button"
                    className="dim-btn ghost sm"
                    onClick={onClose}
                    aria-label="close"
                >
                    ✕
                </button>
            </header>
            {error && <p className="error small">{error}</p>}
            {(login || tray?.waitingForLogin) && (
                <LoginPanel
                    onDone={() => {
                        onCloseLogin()
                        onChange()
                    }}
                    onClose={onCloseLogin}
                />
            )}
            {tray && !tray.account.loggedIn && !login && !tray.waitingForLogin && (
                <button type="button" className="dim-btn sm" onClick={onLogin}>
                    Log in
                </button>
            )}
            {!tray?.uploads.length && (
                <p className="muted small">
                    Nothing uploading. Use a row's Upload button.
                </p>
            )}
            {tray?.uploads.slice().reverse().map((upload) => (
                <Row
                    key={upload.id}
                    upload={upload}
                    waitingForLogin={!!tray && (tray.waitingForLogin || !tray.account.loggedIn)}
                    onChange={onChange}
                />
            ))}
        </aside>
    )
}

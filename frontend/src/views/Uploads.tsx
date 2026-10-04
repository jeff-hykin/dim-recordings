// Uploads to the Dimensional cloud: the tray (progress, phase, ETA, cancel/retry) and the login panel, which is
// Desktop's own page in an iframe (`/dimos/cloud/login/page`, NosyPuma upload_api.md).
import { useEffect, useState } from "react"
import { api, bytes, desktopPath, type Tray, type Upload } from "../api.ts"
import { isDark } from "../dim-app/theme.js"

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

/** The tray's state, polled each second while something's moving (every 5 s otherwise). */
export function useTray() {
    const [tray, setTray] = useState<Tray | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [tick, setTick] = useState(0)
    useEffect(() => {
        let stopped = false
        const read = () =>
            api.tray().then((t) => {
                if (!stopped) {
                    setTray(t)
                    setError(null)
                }
            }, (e) => !stopped && setError(String(e.message ?? e)))
        read()
        const busy = tray?.uploads.some((u) => u.state === "queued" || u.state === "uploading")
        const timer = setInterval(read, busy ? 1000 : 5000)
        return () => {
            stopped = true
            clearInterval(timer)
        }
    }, [tick, tray?.uploads.some((u) => u.state === "queued" || u.state === "uploading")])
    return { tray, error, refresh: () => setTick((n) => n + 1) }
}

export function LoginPanel({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
    useEffect(() => {
        const onMessage = (event: MessageEvent) => {
            if (event.data?.type === "dimos-cloud-login" && ["approved", "loggedIn"].includes(event.data.state)) {
                onDone()
            }
        }
        addEventListener("message", onMessage)
        return () => removeEventListener("message", onMessage)
    }, [onDone])
    return (
        <div className="login">
            <p className="small muted">Log in to the Dimensional cloud to upload. The upload waits until you do.</p>
            <iframe
                title="Dimensional login"
                src={desktopPath(`dimos/cloud/login/page?theme=${isDark() ? "dark" : "light"}`)}
            />
            <button type="button" className="dim-btn ghost sm" onClick={onClose}>Close</button>
        </div>
    )
}

function Row({ upload, onChange }: { upload: Upload; onChange: () => void }) {
    const running = upload.state === "uploading" || upload.state === "queued"
    const fraction = upload.bytesTotal > 0 ? upload.bytesDone / upload.bytesTotal : null
    return (
        <div className={`upload ${upload.state}`} data-state={upload.state}>
            <div className="upload-top">
                <span className="mono name">{upload.name}</span>
                <span className="mono muted small">{bytes(upload.size)}</span>
            </div>
            {running && (
                <div className={`dim-progress ${fraction === null ? "indeterminate" : ""}`}>
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
                        : upload.state}
                    {upload.state === "uploading" && upload.rateBps ? ` · ${bytes(upload.rateBps)}/s` : ""}
                    {upload.state === "uploading" && upload.etaSeconds !== null ? ` · ${eta(upload.etaSeconds)}` : ""}
                </span>
                <span className="upload-actions">
                    {upload.state === "done" && upload.link && (
                        <a className="dim-btn sm primary" href={upload.link} target="_blank" rel="noreferrer">View ↗</a>
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
                <button type="button" className="dim-btn ghost sm" onClick={onClose} aria-label="close">✕</button>
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
                <button type="button" className="dim-btn sm" onClick={onLogin}>Log in</button>
            )}
            {!tray?.uploads.length && <p className="muted small">Nothing uploading. Use a row's Upload button.</p>}
            {tray?.uploads.slice().reverse().map((upload) => (
                <Row
                    key={upload.id}
                    upload={upload}
                    onChange={onChange}
                />
            ))}
        </aside>
    )
}

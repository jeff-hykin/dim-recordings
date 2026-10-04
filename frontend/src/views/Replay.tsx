// The Replayer view (`#/replay/<id>`): this is the slot the Replayer fills in. Its backend routes go in
// backend/replay/routes.ts.
import { useEffect, useState } from "react"
import { api, bytes, duration, type Recording } from "../api.ts"
import { go } from "../App.tsx"

export function Replay({ id }: { id: string }) {
    const [recording, setRecording] = useState<Recording | null>(null)
    const [error, setError] = useState<string | null>(null)
    useEffect(() => {
        api.get(id).then(setRecording, (e) => setError(String(e.message ?? e)))
    }, [id])
    return (
        <div className="replay">
            <header className="bar">
                <button type="button" className="dim-btn ghost sm" onClick={() => go({ view: "library" })}>
                    ← Recordings
                </button>
                <span className="bar-title">Replayer</span>
                <span className="mono muted">{recording?.name ?? id}</span>
            </header>
            <main className="replay-slot" data-replay-slot={id}>
                {error ? <p className="error">{error}</p> : (
                    <div className="empty">
                        <p className="section-head">Replayer</p>
                        <p className="muted">
                            {recording
                                ? `${recording.name} · ${bytes(recording.size)} · ${duration(recording.duration)}`
                                : "loading…"}
                        </p>
                        <p className="muted">Playback is being built here.</p>
                    </div>
                )}
            </main>
        </div>
    )
}

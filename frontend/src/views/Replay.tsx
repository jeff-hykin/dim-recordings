// The Replayer (`#/replay/<id>`): the Controller's live view (3D with point clouds, poses and their path, the tf
// tree, camera panels, layers; src/live is its code) playing a recording, with a timeline docked at the bottom. Its
// backend is backend/replay. Nothing is loaded up front: the page asks for what the playhead needs.
import { useEffect, useMemo, useRef, useState } from "react"
import { go } from "../App.tsx"
import { ViewerApp } from "../live/core/app.ts"
import { persistentStore, useStore } from "../live/core/store.ts"
import type { Playhead } from "../live/core/transport.ts"
import { type CameraLayout, CameraPanels } from "../live/ui/CameraPanels.tsx"
import { SidePanel, type Tab } from "../live/ui/SidePanel.tsx"
import { StatsOverlay } from "../live/ui/StatsOverlay.tsx"
import { TopBar } from "../live/ui/TopBar.tsx"
import { Icon } from "../live/ui/icons.tsx"
import { useMobile } from "../live/ui/useMobile.ts"
import { forgetRoutes } from "../live/layers/odometry.tsx"
import { bytes } from "../api.ts"
import { appEvents } from "../dim-app/events.js"
import { clock, type Overview, replayApi } from "../replay/api.ts"
import { Timeline } from "../replay/Timeline.tsx"
import "../live/styles.css"
import "../replay/replay.css"

declare global {
    var __lv: ViewerApp | undefined
}

export function Replay({ id }: { id: string }) {
    const [overview, setOverview] = useState<Overview | null>(null)
    const [error, setError] = useState<string | null>(null)
    // bumped when the file changes under us (a stream edit): the view is rebuilt on the new file, same playhead
    const [version, setVersion] = useState(0)
    const carried = useRef<Partial<Playhead> | null>(null)
    const expanded = persistentStore("replay.timeline", { expanded: false })
    const { expanded: isExpanded } = useStore(expanded)

    useEffect(() => {
        let gone = false
        setError(null)
        replayApi.overview(id).then(
            (data) => !gone && setOverview(data),
            (e) => !gone && setError(String(e.message ?? e)),
        )
        return () => {
            gone = true
        }
    }, [id, version])

    const reload = () => {
        forgetRoutes()
        setOverview(null)
        setVersion((v) => v + 1)
    }

    if (error) {
        return (
            <div className="replay-page">
                <div className="replay-message">
                    <p className="section-head">Replayer</p>
                    <p className="error">{error}</p>
                    <button
                        type="button"
                        className="dim-btn"
                        onClick={() => go({ view: "library" })}
                    >
                        Back to the recordings
                    </button>
                </div>
            </div>
        )
    }
    if (!overview) {
        return (
            <div className="replay-page">
                <div className="replay-message">
                    <p className="section-head">Replayer</p>
                    <p className="muted">opening {id}…</p>
                </div>
            </div>
        )
    }
    return (
        <LiveReplay
            key={`${overview.id}#${version}`}
            overview={overview}
            initial={carried.current ?? undefined}
            expanded={isExpanded}
            onExpanded={(value) => expanded.set({ expanded: value })}
            onReload={(playhead) => {
                carried.current = playhead
                reload()
            }}
        />
    )
}

function LiveReplay({ overview, initial, expanded, onExpanded, onReload }: {
    overview: Overview
    initial?: Partial<Playhead>
    expanded: boolean
    onExpanded: (expanded: boolean) => void
    onReload: (playhead: Partial<Playhead>) => void
}) {
    const host = useRef<HTMLDivElement>(null)
    const [app, setApp] = useState<ViewerApp | null>(null)
    const mobile = useMobile()
    const [tab, setTab] = useState<Tab | null>(
        () => (matchMedia("(max-width: 720px)").matches ? null : "layers"),
    )
    // camera panels are remembered per recording (another recording's topics wouldn't be there)
    const cameraLayout = useMemo(
        () =>
            persistentStore<CameraLayout>(`lv.cameras.${overview.id}`, {
                panels: [],
                main: null,
            }),
        [overview.id],
    )
    const layout = useStore(cameraLayout)
    const mainCamera = layout.main !== null &&
        layout.panels.some((panel) => panel.id === layout.main)

    useEffect(() => {
        const created = new ViewerApp(
            host.current!,
            overview.id,
            overview,
            initial,
        )
        globalThis.__lv = created
        setApp(created)
        const theme = () => created.viewer.setTheme(document.body.classList.contains("dark"))
        theme()
        addEventListener("dim-theme", theme)
        // the file changed (a stream edit, here or by the agent): start over on it, at the same moment
        created.connection.onReload = () => {
            const { t, speed, loop } = created.connection.playhead.get()
            onReload({ t, speed, loop })
        }
        // the agent drives open players: POST api/replay/{id}/control → a `replay` event on the frontend topic `events`
        const stopEvents = appEvents((message) => {
            if (message.type !== "replay" || message.id !== overview.id) {
                return
            }
            const connection = created.connection
            if (message.action === "play") {
                connection.play()
            } else if (message.action === "pause") {
                connection.pause()
            } else if (message.action === "seek" && typeof message.t === "number") {
                connection.seek(overview.start + message.t)
            } else if (message.action === "speed" && typeof message.speed === "number") {
                connection.playhead.update({
                    speed: Math.min(16, Math.max(0.05, message.speed)),
                })
            }
        })
        return () => {
            stopEvents()
            removeEventListener("dim-theme", theme)
            created.dispose()
            if (globalThis.__lv === created) {
                delete globalThis.__lv
            }
        }
    }, [])

    const head = app ? app.connection.playhead : null
    return (
        <div className={`replay-page ${expanded ? "timeline-expanded" : ""}`}>
            <div className="replay-stage">
                <div
                    className={`lv ${mobile ? "mobile" : "desktop"} ${mainCamera ? "camera-main" : "scene-main"}`}
                    data-testid="replayer"
                >
                    <div className="scene-slot">
                        <div ref={host} className="scene" />
                        {mainCamera && (
                            <button
                                type="button"
                                className="dim-btn round pip-expand"
                                title="Make the 3D view fullscreen"
                                aria-label="Make the 3D view fullscreen"
                                onClick={() => cameraLayout.update({ main: null })}
                            >
                                <Icon name="expand" size={15} />
                            </button>
                        )}
                    </div>
                    {app && (
                        <>
                            <TopBar
                                app={app}
                                tab={tab}
                                onTab={(next) => setTab(tab === next ? null : next)}
                                name={overview.name}
                                detail={`${overview.name} · ${bytes(overview.size)} · ${
                                    clock(overview.end - overview.start)
                                } · ${overview.streams.length} streams`}
                                onBack={() => go({ view: "library" })}
                            />
                            {tab && (
                                <SidePanel
                                    app={app}
                                    tab={tab}
                                    onTab={setTab}
                                    onClose={() => setTab(null)}
                                    mobile={mobile}
                                />
                            )}
                            <CameraPanels app={app} layout={cameraLayout} mobile={mobile} />
                            <StatsOverlay app={app} />
                            {head && <ScrubHint app={app} />}
                        </>
                    )}
                </div>
            </div>
            {app && (
                <Timeline
                    app={app}
                    overview={overview}
                    expanded={expanded}
                    onExpanded={onExpanded}
                    onEdited={(renamed) => {
                        // a camera panel showing a renamed stream follows the new name
                        if (renamed) {
                            const from = `dimos/${renamed.from}/`
                            cameraLayout.update({
                                panels: cameraLayout.get().panels.map((panel) => ({
                                    ...panel,
                                    key: panel.key.startsWith(from)
                                        ? `dimos/${renamed.to}/${panel.key.slice(from.length)}`
                                        : panel.key,
                                })),
                            })
                        }
                        const { t, speed, loop } = app.connection.playhead.get()
                        onReload({ t, speed, loop })
                    }}
                />
            )}
        </div>
    )
}

/** While scrubbing, a small note that the frames are thumbnails until the playhead rests. */
function ScrubHint({ app }: { app: ViewerApp }) {
    const { scrubbing } = useStore(app.connection.playhead)
    if (!scrubbing) {
        return null
    }
    return (
        <div className="scrub-hint dim-badge dim-mono">
            scrubbing · thumbnails until you let go
        </div>
    )
}

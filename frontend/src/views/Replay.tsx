// The Replayer (`#/replay/<id>`): dimos-react's 3D view (the Controller's: follow camera, TF frames, point clouds with
// their look, poses with their whole route, paths) and camera panels, playing a recording from the backend's playback
// socket (replay/source.ts, the data source every layer reads through), with the playback bar docked at the bottom.
// Nothing is loaded up front: the page asks for what the playhead needs.
import { useEffect, useMemo, useState } from "react"
import {
    Badge,
    Button,
    EmptyState,
    ErrorBoundary,
    IconButton,
    PlaybackBar,
    Spinner,
    Text,
    TopBar,
    useBackendEvents,
    useMobile,
} from "dimos-react"
import { Scene3D, SceneControls, SceneStats, TfTree } from "dimos-react/three"
import { useStore } from "../replay/store.ts"
import { DataSourceProvider } from "dimos-react"
import { go } from "../App.tsx"
import { usePersistentState } from "../typed.ts"
import { bytes } from "../api.ts"
import { clock, type Overview, replayApi } from "../replay/api.ts"
import { type Playhead, ReplaySource } from "../replay/source.ts"
import { useStreamLanes } from "../replay/lanes.tsx"
import { CameraPanels, type CameraState } from "../replay/cameras.tsx"
import { SidePanel, type SideTab } from "../replay/side.tsx"
import { DEFAULT_SETTINGS, ReplayLayers, type ReplaySettings } from "../replay/layers.tsx"

export function Replay({ id }: { id: string }) {
    const [overview, setOverview] = useState<Overview | null>(null)
    const [error, setError] = useState<string | null>(null)
    // bumped when the file changes under us (a stream edit): the view is rebuilt on the new file, same playhead
    const [version, setVersion] = useState(0)
    const [carried, setCarried] = useState<Partial<Playhead> | null>(null)

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

    const back = (
        <Button
            variant="primary"
            onClick={() => go({ view: "library" })}
        >
            Back to the recordings
        </Button>
    )
    if (error) {
        return (
            <EmptyState
                layer
                icon="warn"
                tone="warn"
                title={`Couldn't open ${id}`}
                message={`${error}. The file may be unfinished (still recording), damaged, or missing the streams the Replayer draws; try another recording.`}
                actions={back}
                data-testid="onboard-replay-error"
            />
        )
    }
    if (!overview) {
        return (
            <EmptyState
                layer
                icon="play"
                title="Replayer"
                message={
                    <>
                        <Spinner size={14} /> opening {id}…
                    </>
                }
            />
        )
    }
    return (
        <ErrorBoundary
            key={`${overview.id}#${version}`}
            fallback={({ error }: { error: Error }) => (
                <EmptyState
                    layer
                    icon="warn"
                    tone="warn"
                    title={`Couldn't show ${overview.name}`}
                    message={`${error.message}. This browser may not support what the Replayer draws with (WebGL).`}
                    actions={back}
                    data-testid="replay-failed"
                />
            )}
        >
            <LiveReplay
                overview={overview}
                initial={carried ?? undefined}
                onReload={(playhead) => {
                    setCarried(playhead)
                    setOverview(null)
                    setVersion((v) => v + 1)
                }}
            />
        </ErrorBoundary>
    )
}

function LiveReplay({ overview, initial, onReload }: {
    overview: Overview
    initial?: Partial<Playhead>
    onReload: (playhead: Partial<Playhead>) => void
}) {
    const source = useMemo(
        () => new ReplaySource(overview.id, overview, initial),
        [overview.id],
    )
    const tf = useMemo(() => new TfTree({ now: () => source.now() }), [source])
    const head = useStore(source.playhead)
    const mobile = useMobile()
    const [tab, setTab] = useState<SideTab | null>(
        () => (matchMedia("(max-width: 720px)").matches ? null : "layers"),
    )
    const [expanded, setExpanded] = usePersistentState(
        "replay.timeline.expanded",
        false,
    )
    const [settings, setSettings] = usePersistentState<ReplaySettings>(
        "replay.view",
        DEFAULT_SETTINGS,
    )
    // camera panels are remembered per recording (another recording's topics wouldn't be there)
    const [cameras, setCameras] = usePersistentState<CameraState>(
        `replay.cameras.${overview.id}`,
        {
            panels: [],
            main: null,
            seeded: false,
        },
    )
    // a jump (seek, scrub's end, loop) starts over: the TF tree empties (the backend sends the tree as it was then)
    // and the layers that accumulate are rebuilt
    const [epoch, setEpoch] = useState(0)

    useEffect(() => {
        source.start()
        globalThis.__replay = source
        const onSeek = () => {
            tf.clear()
            setEpoch((e) => e + 1)
        }
        source.onSeek.add(onSeek)
        // the file changed (a stream edit, here or by the agent): start over on it, at the same moment
        source.onReload = () => {
            const { t, speed, loop } = source.playhead.get()
            onReload({ t, speed, loop })
        }
        return () => {
            source.onSeek.delete(onSeek)
            source.close()
            if (globalThis.__replay === source) {
                delete globalThis.__replay
            }
        }
    }, [source])

    // the agent drives open players: POST api/replay/{id}/control → a `replay` event on the frontend topic `events`
    useBackendEvents(
        (
            message: {
                type?: string
                id?: string
                action?: string
                t?: number
                speed?: number
            },
        ) => {
            if (message.type !== "replay" || message.id !== overview.id) {
                return
            }
            if (message.action === "play") {
                source.play()
            } else if (message.action === "pause") {
                source.pause()
            } else if (message.action === "seek" && typeof message.t === "number") {
                source.seek(overview.start + message.t)
            } else if (
                message.action === "speed" && typeof message.speed === "number"
            ) {
                source.playhead.update({
                    speed: Math.min(16, Math.max(0.05, message.speed)),
                })
            }
        },
    )

    const [hidden, setHidden] = usePersistentState<Record<string, boolean>>(
        `replay.hidden.${overview.id}`,
        {},
    )
    const lanes = useStreamLanes({
        overview,
        expanded,
        hidden,
        onToggle: (key, shown) => setHidden((old) => ({ ...old, [key]: !shown })),
        onEdited: (renamed) => {
            if (renamed) {
                // a camera panel showing a renamed stream follows the new name
                const from = `dimos/${renamed.from}/`
                setCameras((old) => ({
                    ...old,
                    panels: old.panels.map((panel) => ({
                        ...panel,
                        key: panel.key.startsWith(from)
                            ? `dimos/${renamed.to}/${panel.key.slice(from.length)}`
                            : panel.key,
                    })),
                }))
            }
            const { t, speed, loop } = source.playhead.get()
            onReload({ t, speed, loop })
        },
    })
    const mainCamera = cameras.main !== null &&
        cameras.panels.some((panel) => panel.id === cameras.main)

    return (
        <DataSourceProvider source={source}>
            <div
                className={`rp-page ${mobile ? "rp-mobile" : ""}`}
                data-testid="replayer"
            >
                <TopBar
                    left={
                        <>
                            <IconButton
                                icon="arrow-left"
                                label="Back to the recordings"
                                onClick={() => go({ view: "library" })}
                            />
                            <Text mono className="rp-title" title={overview.name}>
                                {overview.name}
                            </Text>
                        </>
                    }
                    right={
                        <SidePanel.Tabs
                            value={tab}
                            onChange={(next: SideTab) => setTab(tab === next ? null : next)}
                        />
                    }
                >
                    <Text muted small mono className="rp-detail">
                        {bytes(overview.size)} · {clock(overview.end - overview.start)} · {overview.streams.length}{" "}
                        streams
                    </Text>
                </TopBar>
                <div className={`rp-stage ${mainCamera ? "rp-camera-main" : ""}`}>
                    <Scene3D
                        className="rp-scene"
                        tf={tf}
                        clock={() => source.now()}
                        fixedFrame={settings.fixedFrame || undefined}
                        followFrame={settings.follow ? settings.followFrame || "base_link" : null}
                    >
                        <ReplayLayers
                            overview={overview}
                            settings={settings}
                            hidden={hidden}
                            epoch={epoch}
                        />
                        <SceneControls className="rp-scene-controls">
                            {mainCamera && (
                                <IconButton
                                    icon="expand"
                                    label="Make the 3D view fullscreen"
                                    onClick={() => setCameras((old) => ({ ...old, main: null }))}
                                />
                            )}
                        </SceneControls>
                        {settings.showStats && <SceneStats className="rp-stats" />}
                        {tab && (
                            <SidePanel
                                tab={tab}
                                onTab={setTab}
                                onClose={() => setTab(null)}
                                overview={overview}
                                settings={settings}
                                onSettings={(patch) => setSettings((old) => ({ ...old, ...patch }))}
                                hidden={hidden}
                                onHidden={setHidden}
                            />
                        )}
                    </Scene3D>
                    <CameraPanels
                        topics={source.topics}
                        state={cameras}
                        onState={setCameras}
                        mobile={mobile}
                    />
                    {head.scrubbing && (
                        <Badge className="rp-scrub-hint" tone="info">
                            scrubbing · thumbnails until you let go
                        </Badge>
                    )}
                </div>
                <PlaybackBar
                    className="rp-playback"
                    data-testid="timeline"
                    start={overview.start}
                    end={overview.end}
                    value={head.t}
                    playing={head.playing}
                    scrubbing={head.scrubbing}
                    onPlayPause={(
                        play: boolean,
                    ) => (play ? source.play() : source.pause())}
                    onScrubStart={() => {
                        resumeAfterScrub = source.playhead.get().playing
                        source.playhead.update({ scrubbing: true, playing: false })
                    }}
                    onSeek={(t: number) => source.seek(t)}
                    onScrubEnd={() =>
                        source.playhead.update({
                            scrubbing: false,
                            playing: resumeAfterScrub,
                        })}
                    speed={head.speed}
                    onSpeedChange={(speed: number) => source.playhead.update({ speed })}
                    loop={head.loop}
                    onLoopChange={(loop: boolean) => source.playhead.update({ loop })}
                    expanded={expanded}
                    onExpandedChange={setExpanded}
                    lanes={lanes.lanes}
                    view={lanes.view}
                    onViewChange={lanes.setView}
                    keyboard
                />
                {lanes.dialogs}
            </div>
        </DataSourceProvider>
    )
}

/** whether playback resumes when the scrub in progress ends */
let resumeAfterScrub = false

declare global {
    var __replay: ReplaySource | undefined
}

// Camera panels: one by default (the profile's preferred camera), more on demand. Any panel can take over the
// screen, which shrinks the 3D view into a picture-in-picture. Depth is drawn as a colormap; 2D detections can be
// overlaid on any panel. Replayer: frames are drawn into a canvas (not a video element), and a scrubbing thumbnail
// is marked as one until the full-resolution frame replaces it.
import { useEffect, useRef, useState } from "react"
import type { ViewerApp } from "../core/app.ts"
import { type Store, useStore } from "../core/store.ts"
import type { Topic } from "../core/transport.ts"
import { isDepthTopic } from "../core/video.ts"
import { overlayTypeFor } from "../core/layers/registry.ts"
import { decode } from "../core/lcm/lcm.ts"
import { WebGLNotice } from "../../ViewBoundary.tsx"
import { DEFAULT_DEPTH_LOOK, DEPTH_COLORMAPS, DepthCanvas, type DepthLook } from "../core/render/depth.ts"
import { Icon } from "./icons.tsx"

export interface PanelState {
    id: number
    /** image topic key ("" until one is picked) */
    key: string
    /** overlay topic key ("" = none) */
    overlay: string
    x: number
    y: number
    width: number
    height: number
    /** depth topics: colormap and fixed range (null = auto) */
    depth?: DepthLook
}

export interface CameraLayout {
    panels: PanelState[]
    /** the panel shown fullscreen (the 3D view becomes a picture-in-picture), or null */
    main: number | null
    /** a panel was opened on the first camera once (closing it all stays closed) */
    seeded?: boolean
}

const isImage = (topic: Topic) =>
    topic.type === "sensor_msgs.Image" ||
    topic.type === "sensor_msgs.CompressedImage"

function pickDefault(app: ViewerApp, topics: Topic[]): Topic | null {
    const images = topics.filter(isImage)
    for (const name of app.profile.cameras.preferred) {
        const found = images.find((topic) => topic.name === name)
        if (found) {
            return found
        }
    }
    return images.find((topic) => !isDepthTopic(topic)) ?? images[0] ?? null
}

export function CameraPanels(
    { app, layout, mobile }: {
        app: ViewerApp
        layout: Store<CameraLayout>
        mobile: boolean
    },
) {
    const { panels, main, seeded } = useStore(layout)
    const { topics } = useStore(app.connection.status)

    // the first time a camera shows up, open exactly one panel on it
    useEffect(() => {
        if (panels.length || seeded) {
            return
        }
        const first = pickDefault(app, topics)
        if (first) {
            layout.update({
                seeded: true,
                panels: [{
                    id: 1,
                    key: first.key,
                    overlay: "",
                    x: -1,
                    y: -1,
                    width: 360,
                    height: 240,
                }],
            })
        }
    }, [topics, panels.length, seeded, app, layout])

    const update = (id: number, patch: Partial<PanelState>) =>
        layout.update({
            panels: layout.get().panels.map((panel) => panel.id === id ? { ...panel, ...patch } : panel),
        })
    const close = (id: number) =>
        layout.update({
            panels: layout.get().panels.filter((panel) => panel.id !== id),
            main: layout.get().main === id ? null : layout.get().main,
        })
    const add = () => {
        const used = new Set(panels.map((panel) => panel.key))
        const next = topics.filter(isImage).find((topic) => !used.has(topic.key)) ??
            pickDefault(app, topics)
        const id = Math.max(0, ...panels.map((panel) => panel.id)) + 1
        layout.update({
            panels: [...panels, {
                id,
                key: next?.key ?? "",
                overlay: "",
                x: -1,
                y: -1,
                width: 360,
                height: 240,
            }],
        })
    }

    return (
        <div className="camera-layer">
            {panels.map((panel, index) => (
                <CameraPanel
                    key={panel.id}
                    app={app}
                    panel={panel}
                    index={index}
                    topics={topics}
                    isMain={main === panel.id}
                    mobile={mobile}
                    onChange={(patch) => update(panel.id, patch)}
                    onClose={() => close(panel.id)}
                    onMain={() => layout.update({ main: main === panel.id ? null : panel.id })}
                />
            ))}
            <button
                type="button"
                className="dim-btn icon add-camera"
                title="Add a camera panel"
                onClick={add}
            >
                <Icon name="camera" size={16} />
                <Icon name="plus" size={12} />
            </button>
        </div>
    )
}

function CameraPanel(
    { app, panel, index, topics, isMain, mobile, onChange, onClose, onMain }: {
        app: ViewerApp
        panel: PanelState
        index: number
        topics: Topic[]
        isMain: boolean
        mobile: boolean
        onChange: (patch: Partial<PanelState>) => void
        onClose: () => void
        onMain: () => void
    },
) {
    const element = useRef<HTMLDivElement>(null)
    const video = useRef<HTMLCanvasElement>(null)
    const depthHost = useRef<HTMLDivElement>(null)
    const depthRenderer = useRef<DepthCanvas | null>(null)
    const depthLook = panel.depth ?? DEFAULT_DEPTH_LOOK
    const lookRef = useRef(depthLook)
    lookRef.current = depthLook
    const [depthRange, setDepthRange] = useState<[number, number] | null>(null)
    const [depthFailed, setDepthFailed] = useState(false)
    const overlayCanvas = useRef<HTMLCanvasElement>(null)
    const topic = topics.find((other) => other.key === panel.key) ?? null
    const [size, setSize] = useState({
        width: 0,
        height: 0,
        fps: 0,
        quality: "full" as "low" | "full",
    })
    const depth = topic ? isDepthTopic(topic) : false

    // the stream (shared with a 3D projection of the same topic)
    useEffect(() => {
        if (!topic) {
            return
        }
        const source = app.video.acquire(topic)
        let failed = false
        const unsubscribe = depth
            ? source.depth.subscribe(() => {
                const image = source.depth.get().image
                if (image && depthHost.current && !failed) {
                    if (!depthRenderer.current) {
                        // no WebGL2: the panel says so instead of throwing on every frame
                        try {
                            depthRenderer.current = new DepthCanvas()
                        } catch (error) {
                            console.warn("depth panel unavailable:", error)
                            failed = true
                            setDepthFailed(true)
                            return
                        }
                        depthRenderer.current.canvas.className = "camera-media"
                        depthHost.current.prepend(depthRenderer.current.canvas)
                    }
                    const range = depthRenderer.current.draw(image, lookRef.current)
                    setDepthRange((old) =>
                        old && Math.abs(old[0] - range[0]) < 0.05 &&
                            Math.abs(old[1] - range[1]) < 0.05
                            ? old
                            : range
                    )
                    const quality = source.depth.get().quality
                    setSize((old) =>
                        old.width === image.width && old.quality === quality
                            ? old
                            : { width: image.width, height: image.height, fps: 0, quality }
                    )
                }
            })
            : source.video.subscribe(() => draw())
        // the shared canvas, copied into this panel's (two panels may show one topic)
        function draw() {
            const state = source.video.get()
            const canvas = video.current
            if (!canvas || !state.canvas || !state.width) {
                return
            }
            if (canvas.width !== state.width || canvas.height !== state.height) {
                canvas.width = state.width
                canvas.height = state.height
            }
            canvas.getContext("2d")!.drawImage(state.canvas, 0, 0)
            setSize((old) =>
                old.width === state.width && old.height === state.height &&
                    old.fps === state.fps && old.quality === state.quality
                    ? old
                    : {
                        width: state.width,
                        height: state.height,
                        fps: state.fps,
                        quality: state.quality,
                    }
            )
        }
        if (!depth) {
            draw()
        }
        return () => {
            unsubscribe()
            app.video.release(topic)
        }
    }, [app, topic?.key])

    // the overlay (latest message, redrawn as it arrives)
    useEffect(() => {
        const overlayTopic = topics.find((other) => other.key === panel.overlay)
        const type = overlayTopic && overlayTypeFor(overlayTopic.type)
        const canvas = overlayCanvas.current
        if (!overlayTopic || !type || !canvas) {
            canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height)
            return
        }
        return app.connection.subscribe(overlayTopic.key, {
            delivery: "latest",
            maxHz: 30,
        }, (message) => {
            const context = canvas.getContext("2d")!
            const width = size.width || canvas.width,
                height = size.height || canvas.height
            if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width
                canvas.height = height
            }
            context.clearRect(0, 0, width, height)
            try {
                type.draw(context, decode(overlayTopic.type, message.bytes), {
                    width,
                    height,
                })
            } catch {
                // a message the overlay can't read: leave it blank
            }
        })
    }, [app, panel.overlay, topics.length, size.width, size.height])

    // drag by the header (desktop, floating only)
    const startDrag = (event: React.PointerEvent) => {
        if (
            isMain || mobile ||
            (event.target as HTMLElement).closest("button, select")
        ) {
            return
        }
        const box = element.current!.getBoundingClientRect()
        const offsetX = event.clientX - box.left, offsetY = event.clientY - box.top
        const move = (moved: PointerEvent) => {
            const x = Math.max(0, Math.min(innerWidth - 80, moved.clientX - offsetX))
            const y = Math.max(
                48,
                Math.min(innerHeight - 40, moved.clientY - offsetY),
            )
            element.current!.style.left = `${x}px`
            element.current!.style.top = `${y}px`
            element.current!.style.right = "auto"
        }
        const up = () => {
            removeEventListener("pointermove", move)
            removeEventListener("pointerup", up)
            const after = element.current!.getBoundingClientRect()
            onChange({ x: after.left, y: after.top })
        }
        addEventListener("pointermove", move)
        addEventListener("pointerup", up)
    }

    // remember a resize
    useEffect(() => {
        const box = element.current
        if (!box || isMain || mobile) {
            return
        }
        let timer: ReturnType<typeof setTimeout>
        const observer = new ResizeObserver(() => {
            clearTimeout(timer)
            timer = setTimeout(() => {
                if (
                    Math.abs(box.offsetWidth - panel.width) > 2 ||
                    Math.abs(box.offsetHeight - panel.height) > 2
                ) {
                    onChange({ width: box.offsetWidth, height: box.offsetHeight })
                }
            }, 300)
        })
        observer.observe(box)
        return () => observer.disconnect()
    }, [isMain, mobile, panel.width, panel.height])

    const floating = !isMain
    const style: React.CSSProperties = floating && !mobile
        ? {
            width: panel.width,
            height: panel.height,
            ...(panel.x >= 0 ? { left: panel.x, top: panel.y } : { right: 12, top: 60 + index * (panel.height + 12) }),
        }
        : {}
    const overlays = topics.filter((other) => overlayTypeFor(other.type))
    return (
        <div
            ref={element}
            className={`dim-panel camera-panel ${isMain ? "main" : "floating"}`}
            style={style}
            data-panel={panel.id}
        >
            <div
                className="camera-head"
                onPointerDown={startDrag}
                onDoubleClick={onMain}
            >
                <select
                    className="dim-select"
                    value={panel.key}
                    onChange={(event) => onChange({ key: event.target.value })}
                    aria-label="Camera topic"
                >
                    {!topic && (
                        <option value={panel.key}>
                            {panel.key ? "(gone) " + panel.key : "pick a camera"}
                        </option>
                    )}
                    {topics.filter(isImage).map((other) => (
                        <option key={other.key} value={other.key}>{other.name}</option>
                    ))}
                </select>
                {overlays.length > 0 && (
                    <select
                        className="dim-select"
                        value={panel.overlay}
                        onChange={(event) => onChange({ overlay: event.target.value })}
                        aria-label="Overlay"
                    >
                        <option value="">no overlay</option>
                        {overlays.map((other) => <option key={other.key} value={other.key}>{other.name}</option>)}
                    </select>
                )}
                {depth && (
                    <>
                        <select
                            className="dim-select"
                            value={depthLook.colormap}
                            onChange={(event) =>
                                onChange({
                                    depth: { ...depthLook, colormap: event.target.value },
                                })}
                            aria-label="Depth colormap"
                        >
                            {DEPTH_COLORMAPS.map((name) => <option key={name} value={name}>{name}</option>)}
                        </select>
                        <input
                            className="dim-input number depth-range"
                            type="number"
                            step="0.1"
                            placeholder="near"
                            title="near (m); empty = auto"
                            value={depthLook.near ?? ""}
                            onChange={(event) =>
                                onChange({
                                    depth: {
                                        ...depthLook,
                                        near: event.target.value === "" ? null : Number(event.target.value),
                                    },
                                })}
                        />
                        <input
                            className="dim-input number depth-range"
                            type="number"
                            step="0.1"
                            placeholder="far"
                            title="far (m); empty = auto"
                            value={depthLook.far ?? ""}
                            onChange={(event) =>
                                onChange({
                                    depth: {
                                        ...depthLook,
                                        far: event.target.value === "" ? null : Number(event.target.value),
                                    },
                                })}
                        />
                    </>
                )}
                <span className="camera-info" data-quality={size.quality}>
                    {size.width
                        ? `${size.quality === "low" ? "thumbnail · " : ""}${size.width}×${size.height}${
                            size.fps ? ` · ${size.fps} fps` : ""
                        }${depth && depthRange ? ` · ${depthRange[0].toFixed(1)}–${depthRange[1].toFixed(1)} m` : ""}`
                        : "…"}
                </span>
                <button
                    type="button"
                    className="dim-btn icon icon-button"
                    title={isMain ? "Back to the 3D view" : "Fullscreen camera (3D becomes a popup)"}
                    onClick={onMain}
                >
                    <Icon name="expand" size={15} />
                </button>
                <button
                    type="button"
                    className="dim-btn icon icon-button"
                    title="Close"
                    onClick={onClose}
                >
                    <Icon name="close" size={15} />
                </button>
            </div>
            <div
                className="camera-body"
                onClick={mobile && !isMain ? onMain : undefined}
            >
                {depth
                    ? (
                        <div ref={depthHost} className="camera-media depth-host">
                            {depthFailed && <WebGLNotice what="Depth view" />}
                        </div>
                    )
                    : (
                        <canvas
                            ref={video}
                            className={`camera-media ${size.quality === "low" ? "low" : ""}`}
                            data-quality={size.quality}
                        />
                    )}
                <canvas ref={overlayCanvas} className="camera-overlay" />
            </div>
        </div>
    )
}

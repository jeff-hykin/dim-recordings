// Camera panels over the Replayer: one on the first camera by default, more on demand. Any panel can take over the
// stage (the 3D view shrinks into a corner). Frames come from the playback socket as recorded (jpeg/png) or raw; depth
// is drawn through a colormap; 2D detections can be overlaid. While scrubbing they're thumbnails until the playhead rests.
import { useEffect, useState } from "react"
import {
    DEPTH_COLORMAPS,
    FloatingPanel,
    IconButton,
    IMAGE_OVERLAY_TYPES,
    type ImageInfo,
    ImageView,
    NumberInput,
    Select,
    Text,
} from "dimos-react"
import { isDepthStream, type Topic } from "./source.ts"

export interface CameraPanelState {
    id: number
    /** image topic key ("" until one is picked) */
    key: string
    /** overlay topic key ("" = none) */
    overlay: string
    colormap?: string
    near?: number | null
    far?: number | null
}

export interface CameraState {
    panels: CameraPanelState[]
    /** the panel shown on the whole stage (the 3D view becomes a corner), or null */
    main: number | null
    /** a panel was opened on the first camera once (closing it all stays closed) */
    seeded?: boolean
}

const isImage = (topic: Topic) => /^sensor_msgs\.(Image|CompressedImage)$/.test(topic.type)
const PREFERRED = ["/color_image", "/camera/color", "/image"]

function pickDefault(topics: Topic[]): Topic | null {
    const images = topics.filter(isImage)
    return PREFERRED.map((name) => images.find((topic) => topic.name === name))
        .find(Boolean) ??
        images.find((topic) => !isDepthStream(topic.name)) ?? images[0] ?? null
}

function CameraPanel(
    { panel, index, topics, isMain, mobile, onChange, onClose, onMain }: {
        panel: CameraPanelState
        index: number
        topics: Topic[]
        isMain: boolean
        mobile: boolean
        onChange: (patch: Partial<CameraPanelState>) => void
        onClose: () => void
        onMain: () => void
    },
) {
    const [info, setInfo] = useState<ImageInfo | null>(null)
    const topic = topics.find((other) => other.key === panel.key) ?? null
    const depth = topic ? isDepthStream(topic.name) : false
    const overlays = topics.filter((other) => IMAGE_OVERLAY_TYPES.includes(other.type))
    const detail = info?.width
        ? `${info.quality === "low" ? "thumbnail · " : ""}${info.width}×${info.height}${
            info.fps ? ` · ${info.fps} fps` : ""
        }${info.range ? ` · ${info.range[0].toFixed(1)}–${info.range[1].toFixed(1)} m` : ""}`
        : "…"
    const head = (
        <>
            <Select
                size="sm"
                aria-label="Camera topic"
                value={panel.key}
                placeholder="pick a camera"
                options={[
                    ...(!topic && panel.key ? [[panel.key, `(gone) ${panel.key}`]] : []),
                    ...topics.filter(isImage).map((other) => [other.key, other.name]),
                ]}
                onChange={(key: string) => onChange({ key })}
            />
            {overlays.length > 0 && (
                <Select
                    size="sm"
                    aria-label="Overlay"
                    value={panel.overlay}
                    options={[
                        ["", "no overlay"],
                        ...overlays.map((other) => [other.key, other.name]),
                    ]}
                    onChange={(overlay: string) => onChange({ overlay })}
                />
            )}
            {depth && (
                <>
                    <Select
                        size="sm"
                        aria-label="Depth colormap"
                        value={panel.colormap ?? "turbo"}
                        options={DEPTH_COLORMAPS}
                        onChange={(colormap: string) => onChange({ colormap })}
                    />
                    <NumberInput
                        size="sm"
                        step={0.1}
                        unit="m"
                        placeholder="near"
                        title="near (m); 0 = auto"
                        value={panel.near ?? 0}
                        min={0}
                        onChange={(near: number) => onChange({ near: near > 0 ? near : null })}
                    />
                    <NumberInput
                        size="sm"
                        step={0.1}
                        unit="m"
                        placeholder="far"
                        title="far (m); 0 = auto"
                        value={panel.far ?? 0}
                        min={0}
                        onChange={(far: number) => onChange({ far: far > 0 ? far : null })}
                    />
                </>
            )}
            <IconButton
                icon={isMain ? "shrink" : "expand"}
                size="sm"
                label={isMain ? "Back to the 3D view" : "Fill the stage (3D becomes a corner)"}
                onClick={onMain}
            />
        </>
    )
    const view = (
        <ImageView
            className="rp-camera-image"
            topic={panel.key || null}
            encoding={depth ? "dimos_lcm_depth" : "dimos_lcm_image"}
            colormap={panel.colormap ?? "turbo"}
            near={panel.near ?? null}
            far={panel.far ?? null}
            overlayTopic={panel.overlay || null}
            onInfo={setInfo}
            onClick={mobile && !isMain ? onMain : undefined}
            data-panel={panel.id}
        >
            <Text small mono className="rp-camera-info" data-quality={info?.quality}>
                {detail}
            </Text>
        </ImageView>
    )
    if (isMain) {
        return (
            <div className="rp-camera-main-view">
                <div className="rp-camera-main-head">{head}</div>
                {view}
            </div>
        )
    }
    return (
        <FloatingPanel
            className="rp-camera"
            title={topic?.name ?? "camera"}
            icon="camera"
            width={mobile ? 220 : 380}
            persistKey={`replay.camera.${panel.id}`}
            defaultPosition={{ x: -12, y: 60 + index * 290 }}
            actions={head}
            onClose={onClose}
        >
            {view}
        </FloatingPanel>
    )
}

export function CameraPanels({ topics, state, onState, mobile }: {
    topics: Topic[]
    state: CameraState
    onState: (update: (old: CameraState) => CameraState) => void
    mobile: boolean
}) {
    const { panels, main, seeded } = state

    // the first time, open exactly one panel on the first camera
    useEffect(() => {
        if (panels.length || seeded) {
            return
        }
        const first = pickDefault(topics)
        if (first) {
            onState((old) => ({
                ...old,
                seeded: true,
                panels: [{ id: 1, key: first.key, overlay: "" }],
            }))
        }
    }, [topics, panels.length, seeded])

    const update = (id: number, patch: Partial<CameraPanelState>) =>
        onState((old) => ({
            ...old,
            panels: old.panels.map((panel) => panel.id === id ? { ...panel, ...patch } : panel),
        }))
    const close = (id: number) =>
        onState((old) => ({
            ...old,
            panels: old.panels.filter((panel) => panel.id !== id),
            main: old.main === id ? null : old.main,
        }))
    const add = () => {
        const used = new Set(panels.map((panel) => panel.key))
        const next = topics.filter(isImage).find((topic) => !used.has(topic.key)) ??
            pickDefault(topics)
        const id = Math.max(0, ...panels.map((panel) => panel.id)) + 1
        onState((old) => ({
            ...old,
            panels: [...old.panels, { id, key: next?.key ?? "", overlay: "" }],
        }))
    }

    return (
        <>
            {panels.map((panel, index) => (
                <CameraPanel
                    key={panel.id}
                    panel={panel}
                    index={index}
                    topics={topics}
                    isMain={main === panel.id}
                    mobile={mobile}
                    onChange={(patch) => update(panel.id, patch)}
                    onClose={() => close(panel.id)}
                    onMain={() =>
                        onState((old) => ({
                            ...old,
                            main: old.main === panel.id ? null : panel.id,
                        }))}
                />
            ))}
            {topics.some(isImage) && (
                <IconButton
                    className="rp-add-camera"
                    icon="camera"
                    variant="default"
                    label="Add a camera panel"
                    onClick={add}
                />
            )}
        </>
    )
}

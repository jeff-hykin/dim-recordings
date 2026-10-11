// The Replayer's side panel over the 3D view: Layers (each stream's switch and, for clouds, its point look), TF (the
// live tree at the playhead) and Settings (fixed / followed frame, the robot model, stats).
import {
    Button,
    Field,
    IconButton,
    KeyValue,
    Panel,
    Segmented,
    Select,
    Slider,
    Tabs,
    Text,
    Toggle,
    Tree,
} from "dimos-react"
import { FramePicker, GRADIENTS, POINT_STYLES, ROBOT_KINDS, useTf, useTfFrames } from "dimos-react/three"
import { dimosKey } from "dimos-react"
import type { Overview } from "./api.ts"
import { DEFAULT_LOOK, drawable, layerKind, lookFor, type PointLook, type ReplaySettings } from "./layers.tsx"
import { isDepthStream, type StreamInfo } from "./source.ts"

export type SideTab = "layers" | "tf" | "settings"

const TABS = [
    { value: "layers", label: "Layers", icon: "layers" },
    { value: "tf", label: "TF", icon: "tree" },
    { value: "settings", label: "Settings", icon: "settings" },
]

const KIND_LABEL: Record<string, string> = {
    cloud: "point cloud",
    pose: "pose + route",
    path: "path",
    poses: "pose array",
    tf: "tf frames",
}

function LookEditor(
    { look, onChange }: {
        look: PointLook
        onChange: (patch: Partial<PointLook>) => void
    },
) {
    return (
        <div className="rp-look">
            <Select
                size="sm"
                aria-label="Point style"
                value={look.style}
                options={Object.entries(POINT_STYLES).map((
                    [id, style],
                ) => [id, (style as { label: string }).label])}
                onChange={(style: PointLook["style"]) => onChange({ style })}
            />
            <Select
                size="sm"
                aria-label="Color by"
                value={look.colorMode}
                options={[["height", "height"], ["intensity", "intensity"], [
                    "range",
                    "range",
                ], ["solid", "solid"]]}
                onChange={(colorMode: PointLook["colorMode"]) => onChange({ colorMode })}
            />
            <Select
                size="sm"
                aria-label="Gradient"
                value={look.gradient}
                options={GRADIENTS}
                onChange={(gradient: string) => onChange({ gradient })}
            />
            <Slider
                label="size"
                min={0.01}
                max={0.3}
                step={0.01}
                value={look.size}
                format={(value: number) => `${(value * 100).toFixed(0)} cm`}
                onChange={(size: number) => onChange({ size })}
            />
        </div>
    )
}

function LayersTab(
    { overview, settings, onSettings, hidden, onHidden }: SideProps,
) {
    const streams = overview.streams.filter((stream) => stream.count > 0 && drawable(stream))
        .sort((a, b) => a.name.localeCompare(b.name))
    const setLook = (stream: StreamInfo, patch: Partial<PointLook>) => {
        const key = dimosKey(stream.name, stream.type)
        onSettings({
            looks: { ...settings.looks, [key]: { ...settings.looks[key], ...patch } },
        })
    }
    return (
        <div className="rp-layers">
            {streams.map((stream) => {
                const key = dimosKey(stream.name, stream.type)
                const kind = layerKind(stream.type)
                const shown = !hidden[key]
                const cloud = kind === "cloud" && !isDepthStream(stream.name)
                return (
                    <div key={key} className="rp-layer" data-layer={stream.name}>
                        <Toggle
                            size="sm"
                            value={shown}
                            label={stream.name}
                            onChange={(on: boolean) => onHidden({ ...hidden, [key]: !on })}
                        />
                        <Text small muted>
                            {kind ? KIND_LABEL[kind] : isDepthStream(stream.name) ? "depth camera" : "camera"}
                        </Text>
                        {cloud && shown && (
                            <LookEditor
                                look={lookFor(settings, stream)}
                                onChange={(patch) => setLook(stream, patch)}
                            />
                        )}
                        {cloud && shown && settings.looks[key] && (
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setLook(stream, DEFAULT_LOOK)}
                            >
                                Reset look
                            </Button>
                        )}
                    </div>
                )
            })}
            {!streams.length && <Text small muted>Nothing in this recording draws in 3D.</Text>}
        </div>
    )
}

function TfTab() {
    const tf = useTf()
    const frames: string[] = useTfFrames({ throttleMs: 400 })
    const children = new Map<string, string[]>()
    const roots: string[] = []
    for (const frame of frames) {
        const parent = tf?.parentOf(frame)
        if (parent) {
            children.set(parent, [...(children.get(parent) ?? []), frame])
        } else {
            roots.push(frame)
        }
    }
    type Node = { id: string; label: string; children?: Node[] }
    const node = (frame: string, seen: Set<string>): Node => {
        const kids = seen.has(frame) ? [] : (children.get(frame) ?? []).sort()
        const next = new Set(seen).add(frame)
        return {
            id: frame,
            label: frame,
            children: kids.length ? kids.map((kid) => node(kid, next)) : undefined,
        }
    }
    if (!frames.length) {
        return <Text small muted>No TF yet at this moment of the recording.</Text>
    }
    return (
        <div className="rp-tf" data-testid="tf-tree">
            <Text small muted mono>{frames.length} frames</Text>
            <Tree
                nodes={roots.sort().map((root) => node(root, new Set()))}
                defaultExpanded="all"
            />
        </div>
    )
}

function SettingsTab({ settings, onSettings }: SideProps) {
    return (
        <div className="rp-settings">
            <Field label="Fixed frame">
                <FramePicker
                    size="sm"
                    value={settings.fixedFrame || null}
                    noneLabel="auto (world, map, odom…)"
                    onChange={(frame: string | null) => onSettings({ fixedFrame: frame ?? "" })}
                />
            </Field>
            <Field label="Follow frame">
                <FramePicker
                    size="sm"
                    value={settings.followFrame || null}
                    noneLabel="base_link"
                    onChange={(frame: string | null) => onSettings({ followFrame: frame ?? "" })}
                />
            </Field>
            <Toggle
                value={settings.follow}
                label="Camera follows the robot"
                onChange={(follow: boolean) => onSettings({ follow })}
            />
            <Toggle
                value={settings.robotModel}
                label="Robot model"
                onChange={(robotModel: boolean) => onSettings({ robotModel })}
            />
            {settings.robotModel && (
                <Segmented
                    size="sm"
                    value={settings.robotKind}
                    items={(ROBOT_KINDS as string[]).map((kind) => [kind, kind])}
                    onChange={(robotKind: string) => onSettings({ robotKind })}
                />
            )}
            <Toggle
                value={settings.frameNames}
                label="TF frame names"
                onChange={(frameNames: boolean) => onSettings({ frameNames })}
            />
            <Toggle
                value={settings.showStats}
                label="Render stats"
                onChange={(showStats: boolean) => onSettings({ showStats })}
            />
            <KeyValue
                items={[["mouse", "drag orbit · right-drag pan · wheel zoom"], [
                    "keys",
                    "space play · ← → step",
                ]]}
            />
        </div>
    )
}

interface SideProps {
    overview: Overview
    settings: ReplaySettings
    onSettings: (patch: Partial<ReplaySettings>) => void
    hidden: Record<string, boolean>
    onHidden: (hidden: Record<string, boolean>) => void
}

export function SidePanel(
    props: SideProps & {
        tab: SideTab
        onTab: (tab: SideTab) => void
        onClose: () => void
    },
) {
    const { tab, onClose } = props
    return (
        <Panel
            glass
            className="rp-side dr-scene-overlay"
            title={TABS.find((item) => item.value === tab)?.label}
            icon={TABS.find((item) => item.value === tab)?.icon}
            actions={
                <IconButton
                    icon="close"
                    size="sm"
                    label="Close the panel"
                    onClick={onClose}
                />
            }
            bodyClassName="rp-side-body"
        >
            {tab === "layers" ? <LayersTab {...props} /> : tab === "tf" ? <TfTab /> : <SettingsTab {...props} />}
        </Panel>
    )
}

SidePanel.Tabs = function SideTabs(
    { value, onChange }: {
        value: SideTab | null
        onChange: (tab: SideTab) => void
    },
) {
    return (
        <Tabs
            size="sm"
            variant="pill"
            items={TABS}
            value={value}
            onChange={onChange}
            label="Panels"
        />
    )
}

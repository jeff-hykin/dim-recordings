// The Replayer's side panel over the 3D view: Layers (dimos-react's LayersPanel: each stream's switch and settings),
// TF (its TfPanel: the tree at the playhead, problems, hover to find a frame) and Settings (followed frame, the robot
// model, rendering, stats).
import { type ChoiceItem, Field, IconButton, KeyValue, Panel, Segmented, Tabs, Text, Toggle } from "dimos-react"
import { FramePicker, LayersPanel, RenderingSettings, ROBOT_KINDS, TfPanel } from "dimos-react/three"
import type { ReplaySettings, RobotChoice } from "./layers.tsx"
import type { RobotKindAnswer } from "./robot_kind.ts"

export type SideTab = "layers" | "tf" | "settings"

const TABS: ChoiceItem<SideTab>[] = [
    { value: "layers", label: "Layers", icon: "layers" },
    { value: "tf", label: "TF", icon: "tree" },
    { value: "settings", label: "Settings", icon: "settings" },
]

interface SideProps {
    // deno-lint-ignore no-explicit-any
    layers: any
    // deno-lint-ignore no-explicit-any
    tf: any
    // deno-lint-ignore no-explicit-any
    issues: any[]
    activeFixedFrame: string
    hovered: string | null
    onHover: (frame: string | null) => void
    settings: ReplaySettings
    onSettings: (patch: Partial<ReplaySettings>) => void
    robotChoice: RobotChoice
    onRobotChoice: (choice: RobotChoice) => void
    recordingRobot: RobotKindAnswer | null
}

function SettingsTab({ settings, onSettings, robotChoice, onRobotChoice, recordingRobot }: SideProps) {
    return (
        <div className="rp-settings">
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
                <>
                    <Segmented
                        size="sm"
                        value={robotChoice}
                        items={["auto", ...(ROBOT_KINDS as string[]).filter((kind) => kind !== "arrow")].map((
                            kind,
                        ) => [kind, kind])}
                        onChange={onRobotChoice}
                    />
                    <Text muted small data-testid="replay-robot-reason">
                        {robotChoice !== "auto"
                            ? "Picked here for this recording; auto picks from the recording."
                            : recordingRobot
                            ? `Auto: ${recordingRobot.kind}, from ${recordingRobot.reason}.`
                            : "Auto: nothing in this recording says which robot it is, so no model is drawn."}
                    </Text>
                </>
            )}
            <Toggle
                value={settings.showStats}
                label="Render stats"
                onChange={(showStats: boolean) => onSettings({ showStats })}
            />
            <RenderingSettings />
            <KeyValue
                items={[["mouse", "drag orbit · right-drag pan · wheel zoom"], ["keys", "space play · ← → step"]]}
            />
        </div>
    )
}

export function SidePanel(props: SideProps & { tab: SideTab; onClose: () => void }) {
    const { tab, onClose, layers, tf, issues, settings, onSettings, activeFixedFrame, hovered, onHover } = props
    const current = TABS.find((item) => item.value === tab)
    return (
        <Panel
            glass
            className="rp-side dr-scene-overlay"
            title={current?.label}
            icon={current?.icon}
            actions={<IconButton icon="close" size="sm" label="Close the panel" onClick={onClose} />}
            bodyClassName="rp-side-body"
            data-testid={`side-${tab}`}
        >
            {tab === "layers"
                ? <LayersPanel manager={layers} emptyText="Nothing in this recording draws in 3D." />
                : tab === "tf"
                ? (
                    <TfPanel
                        tf={tf}
                        issues={issues}
                        fixedFrame={settings.fixedFrame}
                        activeFixedFrame={activeFixedFrame}
                        onFixedFrame={(frame: string) => onSettings({ fixedFrame: frame })}
                        robotFrame={settings.followFrame || "base_link"}
                        hovered={hovered}
                        onHover={onHover}
                    />
                )
                : <SettingsTab {...props} />}
        </Panel>
    )
}

export function SideTabs({ value, onChange }: { value: SideTab | null; onChange: (tab: SideTab) => void }) {
    return <Tabs size="sm" variant="pill" items={TABS} value={value} onChange={onChange} label="Panels" />
}

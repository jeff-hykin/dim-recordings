// The Replayer's side panel over the 3D view: Layers (dimos-react's LayersPanel: each stream's switch and settings),
// TF (its TfPanel: the tree at the playhead, problems, hover to find a frame) and Settings (followed frame, the robot
// model, rendering, stats).
import { type ChoiceItem, Field, IconButton, KeyValue, Panel, Segmented, Slider, Tabs, Text, Toggle } from "dimos-react"
import { FramePicker, LayersPanel, RenderingSettings, ROBOT_KINDS, TfPanel } from "dimos-react/three"
import type { ReplaySettings, RobotChoice } from "./layers.tsx"
import type { RobotKindAnswer } from "./robot_kind.ts"
import type { DisplayMode } from "./urdf.ts"
import type { RecordingUrdf } from "./use_urdf.ts"
import { gpu, type SimSettings } from "./sim_world.tsx"
import type { SceneData } from "./sim/sceneData.ts"
import { isSoftwareRenderer } from "./sim/grass.ts"

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
    urdf: RecordingUrdf
    drawUrdf: boolean
    simScene: SceneData | null
    simProblem: string | null
    sim: SimSettings
    onSim: (patch: Partial<SimSettings>) => void
}

/** A sim run's world: what it holds, and this viewer's look for it (the Controller's sim scene settings). */
function SimSection({ settings, onSettings, simScene, simProblem, sim, onSim }: SideProps) {
    if (!simScene) {
        return simProblem ? <Text muted small>Simulated world: {simProblem}</Text> : null
    }
    const geoms = simScene.bodies.reduce((count, body) => count + body.geoms.length, 0)
    const movers = simScene.bodies.filter((body) => body.mocap).length
    const percent = (value: number) => `${Math.round(value * 100)}%`
    return (
        <>
            <Toggle
                value={settings.simWorld}
                label="Simulated world"
                onChange={(simWorld: boolean) => onSettings({ simWorld })}
            />
            <Text muted small>
                {simScene.id} · {simScene.bodies.length} bodies · {geoms} geoms · {Object.keys(simScene.meshes).length}
                {" "}
                meshes{movers ? ` · ${movers} moving` : ""}
            </Text>
            {settings.simWorld && (
                <>
                    <Field inline label="Opacity">
                        <Slider
                            min={0.1}
                            max={1}
                            step={0.05}
                            value={sim.opacity}
                            format={percent}
                            onChange={(opacity: number) => onSim({ opacity })}
                        />
                    </Field>
                    <Field inline label="Hide above" title="leaves out ceilings and upper floors">
                        <Slider
                            min={0.5}
                            max={30}
                            step={0.1}
                            value={sim.cutAbove}
                            format={(height: number) => `${height.toFixed(1)} m`}
                            onChange={(cutAbove: number) => onSim({ cutAbove })}
                        />
                    </Field>
                    <Toggle
                        value={sim.lights}
                        label="The world's lights"
                        onChange={(lights: boolean) => onSim({ lights })}
                    />
                    <Toggle
                        value={sim.grass}
                        label="Grass"
                        title={isSoftwareRenderer(gpu())
                            ? `this viewer only; off by default: ${gpu()} is a software GPU`
                            : "this viewer only: blades on the world's grassy hills"}
                        onChange={(grass: boolean) => onSim({ grass })}
                    />
                    {sim.grass && (
                        <>
                            <Field inline label="Grass density">
                                <Slider
                                    min={0.1}
                                    max={2}
                                    step={0.05}
                                    value={sim.grassDensity}
                                    format={percent}
                                    onChange={(grassDensity: number) => onSim({ grassDensity })}
                                />
                            </Field>
                            <Toggle
                                value={sim.sway}
                                label="Wind"
                                title="keeps the view redrawing while grass is on screen"
                                onChange={(sway: boolean) => onSim({ sway })}
                            />
                        </>
                    )}
                </>
            )}
        </>
    )
}

/** Why this model, in words. */
function robotReason({ robotChoice, recordingRobot, urdf, drawUrdf }: SideProps): string {
    const meshes = urdf.meshesWanted ? `, meshes ${urdf.meshesLoaded}/${urdf.meshesWanted}` : ""
    const fromUrdf = urdf.description
        ? `the recording's URDF (${urdf.description.name}, ${urdf.description.links.length} links${meshes})`
        : ""
    if (drawUrdf) {
        return `${robotChoice === "auto" ? "Auto: " : ""}${fromUrdf}.${urdf.problem ? ` ${urdf.problem}` : ""}`
    }
    if (robotChoice !== "auto") {
        return "Picked here for this recording; auto picks from the recording."
    }
    const stand = recordingRobot
        ? `Auto: ${recordingRobot.kind} stand-in, from ${recordingRobot.reason}.`
        : "Auto: nothing in this recording says which robot it is, so no model is drawn."
    // a URDF whose meshes weren't recorded (recorded before the recorder asked for them, or by a recorder that doesn't)
    return urdf.description ? `${stand} Its URDF's meshes aren't in the recording; "urdf" draws what it can.` : stand
}

function SettingsTab(props: SideProps) {
    const { settings, onSettings, robotChoice, onRobotChoice, urdf, drawUrdf } = props
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
            {settings.follow && (
                <Toggle
                    value={settings.followTurns !== false}
                    label="Camera turns with the robot"
                    onChange={(followTurns: boolean) => onSettings({ followTurns })}
                />
            )}
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
                        items={[
                            "auto",
                            ...(urdf.description ? ["urdf"] : []),
                            ...(ROBOT_KINDS as string[]).filter((kind) => kind !== "arrow"),
                        ].map((kind) => [kind, kind])}
                        onChange={onRobotChoice}
                    />
                    <Text muted small data-testid="replay-robot-reason">{robotReason(props)}</Text>
                    {drawUrdf && (
                        <>
                            <Field inline label="Show">
                                <Segmented
                                    size="sm"
                                    value={settings.urdfDisplay}
                                    items={[["visual", "Visual"], ["collision", "Collision"], ["both", "Both"]]}
                                    onChange={(urdfDisplay: DisplayMode) => onSettings({ urdfDisplay })}
                                />
                            </Field>
                            <Field inline label="Opacity">
                                <Slider
                                    min={0.1}
                                    max={1}
                                    step={0.05}
                                    value={settings.urdfOpacity}
                                    format={(opacity: number) => `${Math.round(opacity * 100)}%`}
                                    onChange={(urdfOpacity: number) => onSettings({ urdfOpacity })}
                                />
                            </Field>
                        </>
                    )}
                </>
            )}
            <SimSection {...props} />
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

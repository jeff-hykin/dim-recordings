// The Replayer's view settings. What each stream is drawn as is dimos-react's: its LayerManager makes an entry per
// stream some layer type draws (point clouds, poses with their whole recorded route, paths, markers, occupancy grids,
// TF, camera frustums...), <TopicLayers> runs them and <LayersPanel> switches and edits them.
import type { DisplayMode } from "./urdf.ts"

export interface ReplaySettings {
    /** "" = the TF tree's world-ish root */
    fixedFrame: string
    follow: boolean
    /** while following, the camera turns with the robot's heading (a view saved before this setting reads it as on) */
    followTurns?: boolean
    /** "" = base_link */
    followFrame: string
    robotModel: boolean
    /** the URDF model's geometry (visual, collision or both) and opacity */
    urdfDisplay: DisplayMode
    urdfOpacity: number
    showStats: boolean
}

export const DEFAULT_SETTINGS: ReplaySettings = {
    fixedFrame: "",
    follow: true,
    followTurns: true,
    followFrame: "",
    robotModel: true,
    urdfDisplay: "visual",
    urdfOpacity: 1,
    showStats: false,
}

/** Settings → robot model, per recording: "auto" (the recording's URDF when its meshes were recorded, else what the
 * recording says it is: robot_kind.ts), "urdf" (the URDF whatever it holds) or a ROBOT_KINDS stand-in (the Robot model
 * switch turns it off) */
export type RobotChoice = string

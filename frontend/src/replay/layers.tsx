// The Replayer's view settings. What each stream is drawn as is dimos-react's: its LayerManager makes an entry per
// stream some layer type draws (point clouds, poses with their whole recorded route, paths, markers, occupancy grids,
// TF, camera frustums...), <TopicLayers> runs them and <LayersPanel> switches and edits them.
export interface ReplaySettings {
    /** "" = the TF tree's world-ish root */
    fixedFrame: string
    follow: boolean
    /** "" = base_link */
    followFrame: string
    robotModel: boolean
    robotKind: string
    showStats: boolean
}

export const DEFAULT_SETTINGS: ReplaySettings = {
    fixedFrame: "",
    follow: true,
    followFrame: "",
    robotModel: true,
    robotKind: "dog",
    showStats: false,
}

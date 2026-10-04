// The Controller's core, wired to a recording instead of the bridge: the replay connection (transport.ts), TF, the
// 3D view, layers and camera streams. What the live Controller has and a replay must not: drive (WASD, sticks, arm),
// the agent link, location labels, the recorder, battery alerts; none of them are here. The UI reads the stores;
// window.__lv exposes this for tests, as in the Controller.
import * as THREE from "three"
import { Connection, type Playhead, type StreamInfo } from "./transport.ts"
import { TfTree } from "./tf.ts"
import { feedTf } from "./tfFeed.ts"
import { Viewer } from "./render/viewer.ts"
import { LayerManager } from "./layers/manager.ts"
import { VideoSources } from "./video.ts"
import { robotPose } from "./robot.ts"
import { persistentStore, Store } from "./store.ts"
import { profiles } from "../profile/index.ts"
import type { RobotProfile } from "../profile/types.ts"
import "../layers/index.ts"

export interface ViewSettings {
    profile: string
    /** "" = the profile's, else picked from the tree */
    fixedFrame: string
    follow: boolean
    showStats: boolean
}

let current: ViewerApp | null = null

/** The Controller sends its camera buttons through its backend; here they act on the open view directly. */
export function cameraAction(action: "recenter" | "topDown"): Promise<void> {
    current?.recenter(action === "topDown")
    return Promise.resolve()
}

export class ViewerApp {
    readonly connection: Connection
    readonly tf = new TfTree()
    readonly viewer: Viewer
    readonly video: VideoSources
    readonly layers: LayerManager
    readonly settings = persistentStore<ViewSettings>("lv.view", {
        profile: profiles[0].name,
        fixedFrame: "",
        follow: true,
        showStats: false,
    })
    readonly profile: RobotProfile
    readonly frameInfo = new Store<{ fixedFrame: string; robotFound: boolean }>({
        fixedFrame: "",
        robotFound: false,
    })
    robotMatrix: THREE.Matrix4 | null = null
    #framed = false
    #robotPosition: THREE.Vector3 | null = null
    /** the world frame the recording's poses are in (world / map / odom), the default fixed frame */
    #poseFrame = ""

    constructor(
        host: HTMLElement,
        recordingId: string,
        overview: { start: number; end: number; streams: StreamInfo[] },
        playhead?: Partial<Playhead>,
    ) {
        current = this
        this.profile = profiles.find((profile) => profile.name === this.settings.get().profile) ?? profiles[0]
        this.connection = new Connection(recordingId, overview, playhead)
        // staleness and fading follow the playhead: a paused replay doesn't age
        TfTree.clock = () => this.connection.bridgeNow()
        this.viewer = new Viewer(host, () => this.connection.bridgeNow())
        this.video = new VideoSources(this.connection)
        this.layers = new LayerManager(
            this.viewer,
            this.tf,
            this.connection,
            this.video,
            this.profile,
        )
        feedTf(this.connection, this.tf, this.viewer)
        this.viewer.onFrame(() => this.#eachFrame())
        this.connection.start()
        // a recording's tf often lacks world → robot (the robot's own pose stream had it): default to the frame its
        // poses are in, so the route, the robot and world-frame clouds line up
        const pose = overview.streams.find((stream) => stream.kind === "pose" && stream.count > 0)
        if (pose) {
            const url = new URL(
                `api/replay/${encodeURIComponent(recordingId)}/path`,
                location.href,
            )
            url.searchParams.set("stream", pose.name)
            url.searchParams.set("maxPoints", "2")
            fetch(url).then((response) => response.json()).then((route) => {
                if (["world", "map", "odom"].includes(route.frame)) {
                    this.#poseFrame = route.frame
                }
            }).catch(() => {})
        }
    }

    dispose() {
        this.connection.close()
        this.viewer.dispose()
        robotPose.matrix = null
        robotPose.source = null
        if (current === this) {
            current = null
        }
    }

    #eachFrame() {
        const chosen = this.settings.get().fixedFrame || this.profile.fixedFrame
        // a frame the recording's tree doesn't have (another robot's profile) falls back to the poses' world, then
        // the tree's own root
        const fixedFrame = chosen && this.tf.has(chosen)
            ? chosen
            : this.#poseFrame || this.tf.defaultFixedFrame() || chosen
        if (fixedFrame !== this.viewer.fixedFrame) {
            this.viewer.fixedFrame = fixedFrame
            this.viewer.requestRender()
        }
        const base = this.tf.lookup(this.profile.baseFrame, fixedFrame)
        const robot = base ?? robotPose.matrix
        this.robotMatrix = robot
        const position = robot ? new THREE.Vector3().setFromMatrixPosition(robot) : null
        this.#robotPosition = position
        if (position && !this.#framed) {
            this.#framed = true
            this.viewer.followTarget = position
            this.viewer.frame(position, 7)
        }
        this.viewer.followTarget = this.settings.get().follow ? position : null
        const info = this.frameInfo.get()
        if (info.fixedFrame !== fixedFrame || info.robotFound !== !!position) {
            this.frameInfo.set({ fixedFrame, robotFound: !!position })
        }
    }

    /** Recenter on the robot (or the origin). */
    recenter(topDown = false) {
        const target = this.#robotPosition?.clone() ?? new THREE.Vector3()
        if (topDown) {
            this.viewer.topDown(target, 14)
        } else {
            this.viewer.frame(target, 7)
        }
    }
}

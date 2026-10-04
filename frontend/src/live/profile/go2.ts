// Unitree Go2 (and the default for any wheeled/legged base): WASD drive, Q/E strafe.
import type { RobotProfile } from "./types.ts"

/** The usual ground-robot keys: W/S forward/back, A/D turn, Q/E strafe (REP-103: +y is left, +yaw counter-clockwise). */
export const groundKeys: RobotProfile["drive"]["keys"] = {
    KeyW: { axis: "forward", value: 1 },
    ArrowUp: { axis: "forward", value: 1 },
    KeyS: { axis: "forward", value: -1 },
    ArrowDown: { axis: "forward", value: -1 },
    KeyA: { axis: "turn", value: 1 },
    ArrowLeft: { axis: "turn", value: 1 },
    KeyD: { axis: "turn", value: -1 },
    ArrowRight: { axis: "turn", value: -1 },
    KeyQ: { axis: "strafe", value: 1 },
    KeyE: { axis: "strafe", value: -1 },
}

const go2: RobotProfile = {
    name: "Unitree Go2",
    baseFrame: "base_link",
    fixedFrame: "",
    drive: {
        cmdVelTopics: ["/tele_cmd_vel", "/cmd_vel"],
        speeds: { linear: 0.5, angular: 0.8, vertical: 0 },
        boost: { linear: 2, angular: 0.5 },
        publishHz: 20,
        deadmanMs: 400,
        keys: groundKeys,
    },
    controls: [],
    cameras: {
        preferred: ["/color_image", "/camera/color", "/image"],
        cameraInfo: {},
    },
}

export default go2

// Galaxea R1 Pro: a wheeled base plus a torso that can rise and sink. The height slider (and R/F keys) is the
// worked example of a robot-specific control: point `topic`/`type`/`message` at your robot's height command.
import type { RobotProfile } from "./types.ts"
import { groundKeys } from "./go2.ts"

const r1: RobotProfile = {
    name: "Galaxea R1 Pro",
    baseFrame: "base_link",
    fixedFrame: "",
    drive: {
        cmdVelTopics: ["/cmd_vel", "/tele_cmd_vel"],
        speeds: { linear: 0.3, angular: 0.5, vertical: 0 },
        boost: { linear: 2, angular: 0.5 },
        publishHz: 20,
        deadmanMs: 400,
        keys: {
            ...groundKeys,
            KeyR: { control: "torso_height", step: 0.02 },
            KeyF: { control: "torso_height", step: -0.02 },
        },
    },
    controls: [
        {
            kind: "slider",
            id: "torso_height",
            label: "Torso height",
            topic: "/torso_height",
            type: "std_msgs.Float32",
            min: 0,
            max: 0.4,
            step: 0.01,
            initial: 0.2,
            unit: "m",
            message: (value) => ({ data: value }),
        },
    ],
    cameras: {
        preferred: ["/head_left/image", "/head_camera/color", "/color_image"],
        cameraInfo: {},
    },
}

export default r1

// A drone: Q/E change altitude instead of strafing (the vertical axis → linear.z), and a "Land" button.
import type { RobotProfile } from "./types.ts"
import { groundKeys } from "./go2.ts"

const drone: RobotProfile = {
    name: "Drone",
    baseFrame: "base_link",
    fixedFrame: "",
    drive: {
        cmdVelTopics: ["/cmd_vel"],
        speeds: { linear: 1, angular: 1, vertical: 0.5 },
        boost: { linear: 2, angular: 0.5 },
        publishHz: 20,
        deadmanMs: 400,
        keys: {
            ...groundKeys,
            KeyQ: { axis: "vertical", value: -1 },
            KeyE: { axis: "vertical", value: 1 },
        },
    },
    controls: [
        {
            kind: "button",
            id: "land",
            label: "Land",
            topic: "/land",
            type: "std_msgs.Bool",
            message: () => ({ data: true }),
        },
    ],
    cameras: { preferred: ["/color_image"], cameraInfo: {} },
}

export default drone

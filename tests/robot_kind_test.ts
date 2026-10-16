// The Replayer's robot model comes from the recording (frontend/src/replay/robot_kind.ts), never a default dog.
import { assertEquals } from "@std/assert"
import { kindFromName, recordingRobotKind } from "../frontend/src/replay/robot_kind.ts"

// TF frames as the R1 recordings in ~/.dimos/recordings have them (dtk data summary)
const R1_FRAMES = [
    "odom",
    "lidar_pointlio_link",
    "base_link",
    "steer_motor_link1",
    "torso_link4",
    "head_link",
    "camera_head_left_link",
    "left_arm_link7",
]
const R1_SLAM_FRAMES = [
    "odom",
    "lidar_pointlio_link",
    "base_link",
    "camera_head_left_link",
    "lidar_chassis_left_link",
    "left_d405_link",
]
const GO2_FRAMES = [
    "go2_odom",
    "base_link",
    "camera_link",
    "camera_optical",
    "odom",
    "mid360_link",
]

Deno.test("an R1 recording is the wheeled R1 Pro, whatever its name", () => {
    assertEquals(
        recordingRobotKind({ frames: R1_FRAMES, name: "controller_1792018874" })
            ?.kind,
        "wheeled",
    )
    assertEquals(
        recordingRobotKind({ frames: R1_SLAM_FRAMES, name: "stitch" })?.kind,
        "wheeled",
    )
})

Deno.test("a Go2 recording is the dog", () => {
    assertEquals(
        recordingRobotKind({ frames: GO2_FRAMES, name: "kronk" })?.kind,
        "dog",
    )
    assertEquals(
        recordingRobotKind({ frames: ["odom", "FL_hip", "base_link"], name: "x" })
            ?.kind,
        "dog",
    )
})

Deno.test("frames outrank the file name", () => {
    assertEquals(
        recordingRobotKind({ frames: R1_FRAMES, name: "go2_mislabelled" })?.kind,
        "wheeled",
    )
})

Deno.test("an unidentified recording draws no model (not a dog)", () => {
    assertEquals(
        recordingRobotKind({
            frames: ["odom", "base_link", "camera_link"],
            name: "dimpi5_cams_20s",
        }),
        null,
    )
    assertEquals(
        recordingRobotKind({ frames: [], name: "lite_recorder_park" }),
        null,
    )
})

Deno.test("with no TF, the file name decides", () => {
    assertEquals(kindFromName("r1_live_20260930_1332"), "wheeled")
    assertEquals(kindFromName("misc_test_go2_kronk"), "dog")
    assertEquals(kindFromName("alfred_rtab"), "wheeled")
    assertEquals(kindFromName("g1_walk"), "humanoid")
    assertEquals(kindFromName("sf_555_office_1"), null)
})

Deno.test("a recorded URDF outranks the frames", () => {
    const r1 = `<?xml version="1.0"?><robot name="r1pro"><link name="base_link"/></robot>`
    assertEquals(
        recordingRobotKind({ urdf: r1, frames: GO2_FRAMES, name: "x" })?.kind,
        "wheeled",
    )
    const unnamed = `<robot name="robot"><link name="base_link"/><link name="FR_thigh"/></robot>`
    assertEquals(
        recordingRobotKind({ urdf: unnamed, frames: [], name: "x" })?.reason,
        "Unitree Go2 URDF link FR_thigh",
    )
})

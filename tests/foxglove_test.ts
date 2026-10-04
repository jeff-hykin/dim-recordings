import { assert, assertEquals } from "@std/assert"
import { findFoxglove, foxgloveVerdict } from "../backend/recordings/foxglove.ts"
import { openTargets } from "../backend/recordings/open.ts"

const stream = (name: string, type: string, encoding: string, hasSchema = true) => ({
    name,
    type,
    encoding,
    hasSchema,
    count: 10,
    start: 0,
    end: 1,
    duration: 1,
    hz: 10,
    p99Gap: 0.1,
    p99Ratio: 1,
    maxGap: 0.1,
    gapRatio: 1,
})

Deno.test("foxglove: an .mcap whose image, point cloud and camera_info channels are CDR with a schema", () => {
    const streams = [
        stream("lidar", "sensor_msgs.PointCloud2", "cdr"),
        stream("color_image", "sensor_msgs.CompressedImage", "cdr"),
        stream("camera_info", "sensor_msgs.CameraInfo", "cdr"),
        stream("debug", "std_msgs.String", "json"), // not drawn: doesn't matter
    ]
    assert(foxgloveVerdict("mcap", { streams }).ok)
})

Deno.test("foxglove: refused for a .db, a raw-LCM image, a schema-less point cloud", () => {
    assertEquals(foxgloveVerdict("db", { streams: [] }).ok, false)
    const lcm = foxgloveVerdict("mcap", { streams: [stream("cam", "sensor_msgs.Image", "lcm")] })
    assertEquals(lcm.ok, false)
    assert(lcm.reason.includes("cam (lcm)"))
    const noSchema = foxgloveVerdict("mcap", { streams: [stream("lidar", "sensor_msgs.PointCloud2", "cdr", false)] })
    assertEquals(noSchema.ok, false)
    assert(noSchema.reason.includes("no schema"))
    assertEquals(foxgloveVerdict("mcap", { streams: [stream("ci", "sensor_msgs.CameraInfo", "lcm")] }).ok, false)
    assertEquals(foxgloveVerdict("mcap", null).ok, false)
})

Deno.test("foxglove install detection: the mac app, else foxglove / foxglove-studio on PATH", () => {
    assertEquals(findFoxglove("darwin", (p) => p === "/Applications/Foxglove.app", () => null)?.command[0], "open")
    assertEquals(
        findFoxglove("linux", () => false, (n) => n === "foxglove-studio" ? "/usr/bin/foxglove-studio" : null)?.command,
        [
            "/usr/bin/foxglove-studio",
        ],
    )
    assertEquals(findFoxglove("linux", () => false, () => null), null)
})

Deno.test("open menu: Replayer always; Map Editor and Foxglove only when installed; rrd by Rerun app, CLI, or disabled", () => {
    const cdr = { streams: [stream("cam", "sensor_msgs.Image", "cdr")] } as never
    const none = { apps: [], foxglove: false, rerunCli: false }
    assertEquals(openTargets("db", cdr, none).map((t) => t.target), ["replayer"])
    const all = { apps: ["dim-map-builder", "dim-rerun"], foxglove: true, rerunCli: true }
    assertEquals(openTargets("mcap", cdr, all).map((t) => [t.target, t.ok]), [
        ["replayer", true],
        ["map-editor", true],
        [
            "foxglove",
            true,
        ],
    ])
    assertEquals(openTargets("db", cdr, all).find((t) => t.target === "foxglove")?.ok, false)
    assertEquals(openTargets("rrd", null, all)[0].reason, "in the Rerun app")
    assertEquals(openTargets("rrd", null, { ...none, rerunCli: true })[0].ok, true)
    assertEquals(openTargets("rrd", null, none)[0].ok, false)
})

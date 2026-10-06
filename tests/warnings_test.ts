// The summary's warnings: a broken tf tree and streams with outlier gaps, sags, late starts and early stops.
import { assert, assertEquals } from "@std/assert"
import { join } from "node:path"
import { inspect } from "../backend/recordings/inspect.ts"
import { type EdgeSpan, streamWarnings, tfWarnings } from "../backend/recordings/warnings.ts"
import { lcmTf, range, tempDir, writeDb } from "./fixtures.ts"

const T0 = 1_780_000_000
const edge = (parent: string, child: string, first = 0, last = 60, hz = 10): EdgeSpan => ({
    parent,
    child,
    count: Math.round((last - first) * hz) + 1,
    first,
    last,
    hz,
    static: false,
})

Deno.test("tfWarnings: a clean tree says nothing", () => {
    assertEquals(
        tfWarnings([edge("map", "odom"), edge("odom", "base_link")], 0, 60, new Map([["lidar", "base_link"]])),
        [],
    )
})

Deno.test("tfWarnings: two parents, a cycle, separate trees, an unplaced frame, edges that stop together", () => {
    const kinds = (edges: EdgeSpan[], frames = new Map<string, string>()) =>
        tfWarnings(edges, 0, 60, frames).map((w) => w.kind)
    assertEquals(kinds([edge("map", "base_link"), edge("odom", "base_link"), edge("map", "odom")]), ["two parents"])
    assert(kinds([edge("a", "b"), edge("b", "a")]).includes("cycle"))
    const forest = tfWarnings([edge("map", "odom"), edge("world", "lidar")], 0, 60, new Map())
    assertEquals(forest.map((w) => w.kind), ["forest"])
    assert(forest[0].detail.includes("map (2)"))
    assertEquals(kinds([edge("map", "odom")], new Map([["cloud", "camera_link"]])), ["unplaced"])
    const stops = tfWarnings([edge("map", "odom", 0, 30), edge("odom", "base_link", 0, 30.5)], 0, 60, new Map())
    assertEquals(stops.map((w) => w.kind), ["stops early"])
    assert(stops[0].message.includes("2 transforms stop"))
    assertEquals(kinds([edge("map", "odom", 20, 60)]), ["starts late"])
})

Deno.test("streamWarnings: an outlier gap, a rate drop, a late start; a steady or bursty stream says nothing", () => {
    const steady = range(0, 600, 0.1)
    assertEquals(streamWarnings("odom", steady, 0, 60), [])
    const gappy = [...range(0, 200, 0.1), ...range(25, 350, 0.1)]
    const gap = streamWarnings("odom", gappy, 0, 60)
    assertEquals(gap.map((w) => w.kind), ["gap"])
    assert(gap[0].message.includes("5.10 s gap"), gap[0].message)
    assert(gap[0].detail.includes("+0:20"), gap[0].detail)
    const sag = [...range(0, 200, 0.1), ...range(20, 50, 0.4), ...range(40, 200, 0.1)]
    assertEquals(streamWarnings("camera", sag, 0, 60).map((w) => w.kind), ["rate drop"])
    assertEquals(streamWarnings("lidar", range(20, 400, 0.1), 0, 60).map((w) => w.kind), ["starts late"])
    // a stream published on events: lots of long gaps is its nature, not a fault
    const bursty = range(0, 60, 1).flatMap((t) => (t % 7 === 0 ? range(t, 5, 0.01) : []))
    assertEquals(streamWarnings("goal", bursty, 0, 60).filter((w) => w.kind === "gap"), [])
})

Deno.test("inspect: a recording with a gap and a disconnected tf frame warns about both; a clean one doesn't", async () => {
    const dir = await tempDir()
    const tf = [...range(T0, 600, 0.1)]
    writeDb(join(dir, "broken.db"), [
        {
            name: "odom",
            payload: "dimos.msgs.nav_msgs.Odometry.Odometry",
            times: [...range(T0, 200, 0.1), ...range(T0 + 28, 320, 0.1)],
        },
        {
            name: "tf",
            payload: "dimos.msgs.tf2_msgs.TFMessage.TFMessage",
            times: tf,
            blob: (i) => i % 2 ? lcmTf("map", "base_link") : lcmTf("camera_mount", "camera"),
        },
    ])
    const broken = await inspect(join(dir, "broken.db"))
    assertEquals(broken.warnings.map((w) => w.kind), ["forest", "gap"])
    assertEquals(broken.tf.edges.length, 2)
    assert(broken.tf.edges.every((e) => Math.abs(e.hz - 5) < 0.1), JSON.stringify(broken.tf.edges))
    writeDb(join(dir, "clean.db"), [
        { name: "odom", payload: "dimos.msgs.nav_msgs.Odometry.Odometry", times: range(T0, 600, 0.1) },
        {
            name: "tf",
            payload: "dimos.msgs.tf2_msgs.TFMessage.TFMessage",
            times: tf,
            blob: () => lcmTf("map", "base_link"),
        },
    ])
    assertEquals((await inspect(join(dir, "clean.db"))).warnings, [])
    await Deno.remove(dir, { recursive: true })
})

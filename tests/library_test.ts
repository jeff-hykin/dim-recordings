// Listing, rrd pairing, inspection and the file actions over real (tiny) .db and .mcap files in a temp folder.
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert"
import { join } from "node:path"
import { deleteRecording, duplicateRecording, renameRecording } from "../backend/recordings/actions.ts"
import { conversions, DTK_COMMIT, DTK_URL, dtkCommand } from "../backend/recordings/convert.ts"
import { inspect, shortType, streamSummary } from "../backend/recordings/inspect.ts"
import { Library } from "../backend/recordings/library.ts"
import { pairRrds, resolveId, scanFiles } from "../backend/recordings/scan.ts"
import { frameTimes, imageClass, pickMainCamera } from "../backend/recordings/thumbnails.ts"
import { lcmImage, lcmTf, range, tempDir, writeDb, writeMcap } from "./fixtures.ts"

const T0 = 1_780_000_000 // a 2026 wall time

async function folder() {
    const dir = await tempDir()
    writeDb(join(dir, "walk.db"), [
        { name: "odom", payload: "dimos.msgs.nav_msgs.Odometry.Odometry", times: range(T0, 50, 0.1) },
        {
            name: "color_image",
            payload: "dimos.msgs.sensor_msgs.Image.Image",
            times: range(T0, 20, 0.25),
            blob: () => lcmImage(8, 6, "rgb8"),
        },
        {
            name: "tf",
            payload: "dimos.msgs.tf2_msgs.TFMessage.TFMessage",
            times: range(T0, 5, 1),
            blob: () => lcmTf("world", "base_link"),
        },
        { name: "empty", payload: "dimos.msgs.geometry_msgs.PoseStamped.PoseStamped", times: [] },
    ])
    await writeMcap(join(dir, "drive.mcap"), [
        { topic: "/lidar", encoding: "cdr", schema: "sensor_msgs/msg/PointCloud2", times: range(T0 - 86400, 30, 0.1) },
        { topic: "/image", encoding: "lcm", times: range(T0 - 86400, 10, 0.3), data: () => lcmImage(4, 4) },
    ])
    await Deno.writeTextFile(join(dir, "walk.rrd"), "RRF2")
    await Deno.writeTextFile(join(dir, "other.rrd"), "RRF2")
    await Deno.mkdir(join(dir, "app"))
    await Deno.copyFile(join(dir, "drive.mcap"), join(dir, "app", "inner.mcap"))
    await Deno.writeTextFile(join(dir, "notes.txt"), "not a recording")
    return dir
}

Deno.test("scan: .db/.mcap/.rrd, one folder deep, ids relative; rrds pair by base name, others stand alone", async () => {
    const dir = await folder()
    const files = await scanFiles(dir)
    assertEquals(files.map((f) => f.id).sort(), ["app/inner.mcap", "drive.mcap", "other.rrd", "walk.db", "walk.rrd"])
    const listed = pairRrds(files)
    assertEquals(listed.find((r) => r.id === "walk.db")!.rrds.map((r) => r.id), ["walk.rrd"])
    assertEquals(listed.find((r) => r.id === "other.rrd")!.standalone, true)
    assertEquals(listed.some((r) => r.id === "walk.rrd"), false)
    assertThrows(() => resolveId(dir, "../etc/passwd"))
    assertThrows(() => resolveId(dir, "/etc/passwd"))
})

Deno.test("inspect: a .db's streams, rates, gaps, tf tree; an .mcap's channels and encodings", async () => {
    const dir = await folder()
    const db = await inspect(join(dir, "walk.db"))
    assertEquals(db.format, "db")
    const odom = db.streams.find((s) => s.name === "odom")!
    assertEquals(odom.count, 50)
    assert(Math.abs(odom.hz - 50 / 4.9) < 0.01)
    assertEquals(odom.type, "nav_msgs.Odometry")
    assertEquals(db.streams.find((s) => s.name === "empty")!.count, 0)
    assertEquals(db.tf.edges.map((e) => [e.parent, e.child]), [["world", "base_link"]])
    assertEquals(db.tf.roots, ["world"])
    assertEquals(db.summary, "camera · odometry · tf")
    assert(Math.abs(db.duration! - 4.9) < 1e-6)

    const mcap = await inspect(join(dir, "drive.mcap"))
    assertEquals(mcap.format, "mcap")
    assertEquals(mcap.streams.map((s) => [s.name, s.encoding, s.count]), [["image", "lcm", 10], ["lidar", "cdr", 30]])
    assertEquals(mcap.streams.find((s) => s.name === "lidar")!.type, "sensor_msgs.PointCloud2")
})

Deno.test("library: recorded = first message time, notes survive a rename, cached inspections", async () => {
    const dir = await folder()
    const data = await tempDir()
    const library = new Library({ recordingsDir: dir, dataDir: data, desktopUrl: "", appName: "dim-recordings" })
    const walk = await library.get("walk.db")
    assertEquals(walk.recorded, T0)
    assertEquals(walk.recordedFrom, "messages")
    library.setNote("walk.db", "stairs, twice")
    await renameRecording(walk.path, "stairs")
    library.moveNote("walk.db", "stairs.db")
    // a new Library (a restart) reads the notes back from the data dir
    const again = new Library({ recordingsDir: dir, dataDir: data, desktopUrl: "", appName: "dim-recordings" })
    const list = await again.list()
    assertEquals(list.find((r) => r.id === "stairs.db")!.note, "stairs, twice")
    // the rrd followed the rename, so it's still paired
    assertEquals(list.find((r) => r.id === "stairs.db")!.rrds.map((r) => r.name), ["stairs.rrd"])
    await assertRejects(() => again.get("walk.db"))
})

for (const name of ["walk.db", "drive.mcap"]) {
    Deno.test(`actions on ${name}: rename keeps the extension, duplicate copies, delete removes (with sidecars)`, async () => {
        const dir = await folder()
        const path = join(dir, name)
        const extension = name.slice(name.indexOf("."))
        await Deno.writeTextFile(`${path}-wal`, "")
        const renamed = await renameRecording(path, "renamed")
        assertEquals(renamed, join(dir, `renamed${extension}`))
        assert(!(await exists(path)))
        assert(await exists(`${renamed}-wal`))
        await assertRejects(() => renameRecording(renamed, "../escape"))
        await Deno.writeTextFile(join(dir, `taken${extension}`), "")
        await assertRejects(() => renameRecording(renamed, `taken${extension}`), Error, "already exists")

        const copy = await duplicateRecording(renamed)
        assertEquals(copy, join(dir, `renamed copy${extension}`))
        assertEquals((await Deno.stat(copy)).size, (await Deno.stat(renamed)).size)
        assertEquals(await duplicateRecording(renamed), join(dir, `renamed copy 2${extension}`))
        assertEquals((await inspect(copy)).messages, (await inspect(renamed)).messages)

        await deleteRecording(renamed)
        assert(!(await exists(renamed)))
        assert(!(await exists(`${renamed}-wal`)))
    })
}

Deno.test("delete on a symlink removes the link, never the target", async () => {
    const dir = await folder()
    const elsewhere = await tempDir()
    await Deno.rename(join(dir, "walk.db"), join(elsewhere, "walk.db"))
    await Deno.symlink(join(elsewhere, "walk.db"), join(dir, "walk.db"))
    const listed = await scanFiles(dir)
    assertEquals(listed.find((f) => f.id === "walk.db")!.symlink, true)
    await deleteRecording(join(dir, "walk.db"))
    assert(await exists(join(elsewhere, "walk.db")))
})

Deno.test("main camera: color before grayscale before depth, then resolution", () => {
    const c = (name: string, encoding: string, width: number, height: number) => ({
        name,
        encoding,
        width,
        height,
        count: 5,
    })
    assertEquals(
        pickMainCamera([c("depth", "16UC1", 1280, 720), c("ir_left", "mono8", 848, 480), c("color", "jpeg", 640, 480)])!
            .name,
        "color",
    )
    assertEquals(
        pickMainCamera([c("depth_front", "16UC1", 1280, 720), c("gray_back", "mono8", 640, 480)])!.name,
        "gray_back",
    )
    assertEquals(pickMainCamera([c("a", "rgb8", 640, 480), c("b", "bgr8", 1280, 720)])!.name, "b")
    assertEquals(imageClass("depth_image_left", "mono8"), 2)
    assertEquals(pickMainCamera([]), null)
    const times = frameTimes(0, 100)
    assertEquals(times.length, 15)
    assertEquals([times[0], times[7], times[14]], [0, 50, 100])
})

Deno.test("type names and the stream summary line", () => {
    assertEquals(shortType("dimos.msgs.sensor_msgs.Image.Image"), "sensor_msgs.Image")
    assertEquals(shortType("sensor_msgs/msg/CompressedImage"), "sensor_msgs.CompressedImage")
    assertEquals(
        streamSummary([
            { name: "a", type: "sensor_msgs.Image", count: 1 },
            { name: "b", type: "sensor_msgs.CompressedImage", count: 1 },
            { name: "c", type: "sensor_msgs.CameraInfo", count: 1 },
            { name: "d", type: "sensor_msgs.PointCloud2", count: 0 },
            { name: "tf", type: "tf2_msgs.TFMessage", count: 3 },
            { name: "x", type: "jnav.Graph3D", count: 1 },
        ]),
        "2 cameras · tf · 1 other",
    )
})

async function exists(path: string) {
    try {
        await Deno.lstat(path)
        return true
    } catch {
        return false
    }
}

Deno.test("conversions run the pinned dtk commit on this deno, unless DIM_RECORDINGS_DTK overrides it", () => {
    const saved = Deno.env.get("DIM_RECORDINGS_DTK")
    try {
        Deno.env.delete("DIM_RECORDINGS_DTK")
        assertEquals(dtkCommand(), [Deno.execPath(), "run", "-A", "--no-config", DTK_URL])
        assert(/^[0-9a-f]{40}$/.test(DTK_COMMIT))
        assert(DTK_URL.includes(`/jeff-hykin/dtk/${DTK_COMMIT}/main.js`))
        Deno.env.set("DIM_RECORDINGS_DTK", "deno run -A ~/repos/dtk/main.js")
        assertEquals(dtkCommand().at(-1), `${Deno.env.get("HOME")}/repos/dtk/main.js`)
        assertEquals(conversions("db").map((each) => [each.to, each.ok]), [["mcap", true], ["rrd", true]])
    } finally {
        if (saved === undefined) {
            Deno.env.delete("DIM_RECORDINGS_DTK")
        } else {
            Deno.env.set("DIM_RECORDINGS_DTK", saved)
        }
    }
})

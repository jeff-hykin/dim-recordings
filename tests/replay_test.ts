// The Replayer's backend: lazy reading and seeking (.db and .mcap), what the playback websocket sends in each mode,
// and stream rename / duplicate / delete as in-place edits of a .db and an .mcap, checked by reading the files back.
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { McapWriter } from "../backend/deps.ts"
import { encode as lcmEncode } from "../backend/replay/lcm.ts"
import { inspect } from "../backend/recordings/inspect.ts"
import { openMcap } from "../backend/recordings/mcap.ts"
import { editDb } from "../backend/replay/edit_db.ts"
import { editMcap } from "../backend/replay/edit_mcap.ts"
import { closeAll, Session, TfIndex } from "../backend/replay/player.ts"
import { atOrBefore, openSource } from "../backend/replay/source.ts"
import { handle } from "../backend/http.ts"
import { buildRoutes, DESCRIPTION } from "../backend/routes.ts"
import { makeServices } from "../backend/services.ts"
import { range, tempDir, writeDb } from "./fixtures.ts"

const T0 = 1_780_000_000

const tf = (parent: string, child: string, x = 0) =>
    lcmEncode("tf2_msgs.TFMessage", {
        transforms: [{
            header: { frame_id: parent },
            child_frame_id: child,
            transform: { translation: { x }, rotation: { w: 1 } },
        }],
    })
const pose = (x: number) =>
    lcmEncode("geometry_msgs.PoseStamped", {
        header: { frame_id: "world" },
        pose: { position: { x }, orientation: { w: 1 } },
    })
const image = (width: number, height: number, value: number) =>
    lcmEncode("sensor_msgs.Image", {
        header: { frame_id: "camera" },
        width,
        height,
        encoding: "mono8",
        step: width,
        data: new Uint8Array(width * height).fill(value),
    })

/** a .db with a camera, a pose stream, and tf (two edges: one set once at the start, one moving) */
async function sampleDb() {
    const dir = await tempDir()
    const path = join(dir, "run.db")
    writeDb(path, [
        {
            name: "camera",
            payload: "dimos.msgs.sensor_msgs.Image.Image",
            times: range(T0, 20, 0.5),
            blob: (i) => image(640, 480, i),
        },
        {
            name: "odom",
            payload: "dimos.msgs.geometry_msgs.PoseStamped.PoseStamped",
            times: range(T0, 100, 0.1),
            blob: (i) => pose(i),
        },
        {
            name: "tf",
            payload: "dimos.msgs.tf2_msgs.TFMessage.TFMessage",
            times: range(T0, 10, 1),
            blob: (
                i,
            ) => (i === 0 ? tf("base_link", "camera") : tf("world", "base_link", i)),
        },
    ])
    return { dir, path }
}

/** an .mcap (raw LCM channels) cut into many small chunks */
async function sampleMcap(dir: string) {
    const path = join(dir, "run.mcap")
    const file = await Deno.open(path, {
        write: true,
        create: true,
        truncate: true,
    })
    let position = 0n
    const writer = new McapWriter({
        chunkSize: 1024,
        writable: {
            write: async (buffer: Uint8Array) => {
                let done = 0
                while (done < buffer.length) {
                    done += await file.write(buffer.subarray(done))
                }
                position += BigInt(buffer.byteLength)
            },
            position: () => position,
        },
    })
    await writer.start({ profile: "", library: "test" })
    const channel = async (topic: string, type: string) =>
        await writer.registerChannel({
            topic,
            messageEncoding: "lcm",
            schemaId: 0,
            metadata: new Map([["type", type]]),
        })
    const camera = await channel("/camera", "sensor_msgs.Image")
    const odom = await channel("/odom", "geometry_msgs.PoseStamped")
    const tfChannel = await channel("/tf", "tf2_msgs.TFMessage")
    const messages: { channelId: number; t: number; data: Uint8Array }[] = []
    range(T0, 20, 0.5).forEach((t, i) => messages.push({ channelId: camera, t, data: image(32, 24, i) }))
    range(T0, 100, 0.1).forEach((t, i) => messages.push({ channelId: odom, t, data: pose(i) }))
    range(T0, 10, 1).forEach((t, i) =>
        messages.push({
            channelId: tfChannel,
            t,
            data: i === 0 ? tf("base_link", "camera") : tf("world", "base_link", i),
        })
    )
    messages.sort((a, b) => a.t - b.t)
    let sequence = 0
    for (const message of messages) {
        const time = BigInt(Math.round(message.t * 1e9))
        await writer.addMessage({
            channelId: message.channelId,
            sequence: sequence++,
            logTime: time,
            publishTime: time,
            data: message.data,
        })
    }
    await writer.end()
    file.close()
    return path
}

Deno.test("source: a .db opens and indexes without reading any payload; read(i) gets one message", async () => {
    const { path } = await sampleDb()
    // drop a blob table: opening, listing and indexing must not care (they never read payloads)
    const db = new DatabaseSync(path)
    db.exec('ALTER TABLE "camera_blob" RENAME TO "camera_blob_hidden"')
    db.close()
    const source = await openSource(path)
    try {
        assertEquals(source.streams.map((s) => [s.name, s.kind, s.count]), [
            ["camera", "image", 20],
            ["odom", "pose", 100],
            ["tf", "tf", 10],
        ])
        const { times } = await source.index("camera")
        assertEquals(times.length, 20)
        assertEquals(atOrBefore(times, T0 + 2.25), 4)
        assertEquals(atOrBefore(times, T0 - 1), -1)
        await assertRejects(() => source.read("camera", 3)) // the payload is only read now, and it's gone
        const { times: odomTimes } = await source.index("odom")
        const message = await source.read("odom", atOrBefore(odomTimes, T0 + 5.05))
        assertEquals(message.byteLength, pose(50).byteLength)
    } finally {
        source.close()
    }
})

Deno.test("source: an .mcap indexes from MessageIndex records and decompresses only the chunk a message is in", async () => {
    const dir = await tempDir()
    const path = await sampleMcap(dir)
    const mcap = await openMcap(path)
    const chunks = [...mcap.reader.chunkIndexes].sort((a, b) => Number(a.chunkStartOffset - b.chunkStartOffset))
    mcap.close()
    assert(chunks.length > 10, `want many chunks, got ${chunks.length}`)
    // wreck the last chunk's data: seeking anywhere before it still works, because nothing else is read
    const last = chunks[chunks.length - 1]
    const file = await Deno.open(path, { write: true })
    await file.seek(Number(last.chunkStartOffset) + 60, Deno.SeekMode.Start)
    await file.write(new Uint8Array(64).fill(0xee))
    file.close()
    const source = await openSource(path)
    try {
        const { times } = await source.index("odom")
        assertEquals(times.length, 100)
        const first = await source.read("odom", 0)
        assertEquals(first, pose(0))
        const middle = await source.read("odom", atOrBefore(times, T0 + 3.05))
        assertEquals(middle, pose(30))
    } finally {
        source.close()
    }
})

/** a Session with its sends collected */
async function session(path: string) {
    const source = await openSource(path)
    const tfIndexes = new Map<string, Promise<TfIndex>>()
    const sent: { header: Record<string, unknown>; payload: Uint8Array }[] = []
    const texts: Record<string, unknown>[] = []
    const player = new Session(
        path,
        source,
        (stream) => {
            if (!tfIndexes.has(stream)) {
                tfIndexes.set(stream, TfIndex.build(source, stream))
            }
            return tfIndexes.get(stream)!
        },
        null,
        (data) => {
            if (typeof data === "string") {
                texts.push(JSON.parse(data))
                return
            }
            const length = new DataView(data.buffer, data.byteOffset).getUint32(
                0,
                true,
            )
            sent.push({
                header: JSON.parse(
                    new TextDecoder().decode(data.subarray(4, 4 + length)),
                ),
                payload: data.subarray(4 + length),
            })
        },
    )
    let seq = 0
    const at = async (t: number, mode: string) => {
        const mine = ++seq
        player.onText(JSON.stringify({ op: "at", t, mode, seq: mine }))
        while (!texts.some((text) => text.op === "done" && text.seq === mine)) {
            await new Promise((resolve) => setTimeout(resolve, 2))
        }
    }
    const take = () => sent.splice(0)
    return {
        source,
        player,
        at,
        take,
        close: () => (player.close(), source.close()),
    }
}

Deno.test("player: scrub sends thumbnails, pause full frames, play every small message it crossed", async () => {
    const { path } = await sampleDb()
    const p = await session(path)
    try {
        p.player.onText(
            JSON.stringify({ op: "sub", id: 1, stream: "camera", as: "image" }),
        )
        p.player.onText(
            JSON.stringify({ op: "sub", id: 2, stream: "odom", as: "lcm" }),
        )
        await p.at(T0 + 4.2, "scrub")
        const scrub = p.take()
        const frame = scrub.find((m) => m.header.s === 1)!
        assertEquals(frame.header.q, "low")
        assert(
            (frame.header.w as number) <= 192 && (frame.header.h as number) <= 192,
            "a thumbnail",
        )
        assertEquals(frame.header.t, T0 + 4)
        await p.at(T0 + 4.2, "pause")
        const paused = p.take().find((m) => m.header.s === 1)!
        assertEquals([paused.header.q, paused.header.w, paused.header.h], [
            "full",
            640,
            480,
        ])
        assertEquals(paused.payload.byteLength, 640 * 480)
        // play from 4.2 to 5.0: odom's 4.3 … 5.0 (8 messages) all arrive, in order
        await p.at(T0 + 4.2, "play")
        p.take()
        await p.at(T0 + 5.0, "play")
        const played = p.take().filter((m) => m.header.s === 2).map((m) =>
            Math.round(((m.header.t as number) - T0) * 10)
        )
        assertEquals(played, [43, 44, 45, 46, 47, 48, 49, 50])
    } finally {
        p.close()
    }
})

Deno.test("player: a jump sends the whole tf tree as it was then (an edge set once at the start included)", async () => {
    const { path } = await sampleDb()
    const p = await session(path)
    try {
        p.player.onText(
            JSON.stringify({ op: "sub", id: 7, stream: "tf", as: "lcm" }),
        )
        await p.at(T0 + 6.5, "scrub")
        const times = p.take().filter((m) => m.header.s === 7).map((m) => (m.header.t as number) - T0)
        // message 0 (base_link → camera, never sent again) and message 6 (world → base_link, the latest)
        assertEquals(times, [0, 6])
    } finally {
        p.close()
    }
})

Deno.test("edit .db in place: rename, duplicate, delete a stream; the file reads back right", async () => {
    const { dir, path } = await sampleDb()
    const before = await inspect(path)
    editDb(path, { op: "rename", stream: "odom", to: "odometry" })
    editDb(path, { op: "duplicate", stream: "odometry", to: "odometry_copy" })
    editDb(path, { op: "delete", stream: "camera" })
    assertThrows(
        () => editDb(path, { op: "rename", stream: "tf", to: "odometry" }),
        Error,
        "already",
    )
    assertThrows(
        () => editDb(path, { op: "rename", stream: "tf", to: "bad name" }),
        Error,
        "usable",
    )
    const after = await inspect(path)
    assertEquals(after.streams.map((s) => [s.name, s.count]), [
        ["odometry", 100],
        ["odometry_copy", 100],
        ["tf", 10],
    ])
    assertEquals(after.tf.edges.length, before.tf.edges.length)
    const source = await openSource(path)
    try {
        assertEquals(await source.read("odometry_copy", 42), pose(42))
        assertEquals(await source.read("odometry", 42), pose(42))
    } finally {
        source.close()
    }
    // in place: the folder has the same files it had (SQLite's own -wal/-shm aside), no copy
    const files = [...Deno.readDirSync(dir)].map((entry) => entry.name).filter((
        name,
    ) => !/-(wal|shm|journal)$/.test(name))
    assertEquals(files, ["run.db"])
})

Deno.test("edit .mcap in place: rename, duplicate, delete a topic; indexed and linear reads agree", async () => {
    const dir = await tempDir()
    const path = await sampleMcap(dir)
    const sizeBefore = (await Deno.stat(path)).size
    const renamed = await editMcap(path, {
        op: "rename",
        topic: "odom",
        to: "odometry",
    })
    assert(
        renamed.chunksRewritten >= 1 && renamed.chunksRewritten < 4,
        `rename rewrote ${renamed.chunksRewritten} chunks`,
    )
    const duplicated = await editMcap(path, {
        op: "duplicate",
        topic: "odometry",
        to: "odometry_copy",
    })
    assertEquals(duplicated.messages, 100)
    const deleted = await editMcap(path, { op: "delete", topic: "camera" })
    assertEquals(deleted.messages, 20)
    await assertRejects(
        () => editMcap(path, { op: "rename", topic: "tf", to: "odometry" }),
        Error,
        "already",
    )
    // the same path, no temp file or copy left beside it
    assertEquals([...Deno.readDirSync(dir)].map((entry) => entry.name), [
        "run.mcap",
    ])
    assert((await Deno.stat(path)).size < sizeBefore + 64 * 1024)

    // indexed: the summary
    const after = await inspect(path)
    assertEquals(after.streams.map((s) => [s.name, s.count]), [
        ["odometry", 100],
        ["odometry_copy", 100],
        ["tf", 10],
    ])
    const source = await openSource(path)
    try {
        for (const name of ["odometry", "odometry_copy"]) {
            const { times } = await source.index(name)
            assertEquals(times.length, 100)
            assertEquals(await source.read(name, 77), pose(77))
        }
    } finally {
        source.close()
    }
    // linear: every message through the chunk records, and no Channel record still says "odom" or "camera"
    const mcap = await openMcap(path)
    try {
        const counts = new Map<string, number>()
        for await (const message of mcap.reader.readMessages()) {
            const topic = mcap.reader.channelsById.get(message.channelId)!.topic
            counts.set(topic, (counts.get(topic) ?? 0) + 1)
        }
        assertEquals(Object.fromEntries(counts), {
            "/odometry": 100,
            "/odometry_copy": 100,
            "/tf": 10,
        })
    } finally {
        mcap.close()
    }
    const bytes = await Deno.readFile(path)
    const text = new TextDecoder("latin1").decode(bytes)
    const withoutNewNames = text.replace(/\/odometry/g, "")
    assert(
        !withoutNewNames.includes("/odom") && !withoutNewNames.includes("/camera"),
        "an old name is still in the file",
    )
})

Deno.test("api: stream edits over HTTP refuse a symlinked recording and edit a real one", async () => {
    const { dir, path } = await sampleDb()
    const outside = await tempDir()
    const target = join(outside, "linked.db")
    await Deno.copyFile(path, target)
    await Deno.symlink(target, join(dir, "linked.db"))
    const routes = buildRoutes(
        makeServices({
            recordingsDir: dir,
            dataDir: await tempDir(),
            desktopUrl: "",
            appName: "dim-recordings",
        }),
    )
    const call = async (method: string, url: string, body?: unknown) => {
        const response = await handle(
            new Request(`http://app/${url}`, {
                method,
                body: body === undefined ? undefined : JSON.stringify(body),
            }),
            routes,
            DESCRIPTION,
        )
        return { status: response!.status, body: await response!.json() }
    }
    const refused = await call(
        "POST",
        "api/recordings/linked.db/streams/odom/rename",
        { name: "x" },
    )
    assertEquals(refused.status, 409)
    assertEquals((await inspect(target)).streams.map((s) => s.name), [
        "camera",
        "odom",
        "tf",
    ]) // untouched
    const overview = await call("GET", "api/replay/run.db")
    assertEquals(overview.body.streams.map((s: { name: string }) => s.name), [
        "camera",
        "odom",
        "tf",
    ])
    assertEquals(
        (await call("POST", "api/recordings/run.db/streams/odom/duplicate", {}))
            .body.to,
        "odom_copy",
    )
    assertEquals(
        (await call("POST", "api/recordings/run.db/streams/odom/rename", {
            name: "pose",
        })).status,
        200,
    )
    assertEquals(
        (await call("DELETE", "api/recordings/run.db/streams/camera")).status,
        200,
    )
    const edited = await call("GET", "api/replay/run.db")
    assertEquals(edited.body.streams.map((s: { name: string }) => s.name), [
        "odom_copy",
        "pose",
        "tf",
    ])
    const message = await call(
        "GET",
        "api/replay/run.db/message?stream=pose&t=2.05",
    )
    assertEquals(message.body.message.pose.position.x, 20)
    const route = await call(
        "GET",
        "api/replay/run.db/path?stream=pose&maxPoints=10",
    )
    assertEquals(route.body.frame, "world")
    assertEquals(route.body.points.length, 10)
    await closeAll()
})

// Re-uploads: the versioned name, change detection by topic summary, and the route end to end against a stand-in for
// Desktop's dimos gateway (an upload "finishes" as soon as it's queued; nothing leaves the machine).
import { assert, assertEquals } from "@std/assert"
import { DatabaseSync } from "node:sqlite"
import { basename, join } from "node:path"
import { handle } from "../backend/http.ts"
import { buildRoutes, INFO } from "../backend/routes.ts"
import { makeServices } from "../backend/services.ts"
import {
    type Baseline,
    type GatewayEntry,
    judge,
    splitVersion,
    summaryChanges,
    type TopicSummary,
    topicSummary,
    versionedName,
} from "../backend/recordings/reupload.ts"
import { lcmTf, range, tempDir, writeDb } from "./fixtures.ts"

Deno.test("versionedName: next free vN, parsing a name's own vN", () => {
    assertEquals(splitVersion("run.mcap"), { base: "run", version: 1, ext: ".mcap" })
    assertEquals(splitVersion("run.v12.db"), { base: "run", version: 12, ext: ".db" })
    assertEquals(splitVersion("a.b.mcap"), { base: "a.b", version: 1, ext: ".mcap" })
    assertEquals(splitVersion("run.v2b.mcap"), { base: "run.v2b", version: 1, ext: ".mcap" })
    assertEquals(versionedName("run.mcap", []), "run.v2.mcap")
    assertEquals(versionedName("run.v2.mcap", []), "run.v3.mcap")
    assertEquals(versionedName("run.mcap", ["run.v2.mcap", "run.v4.mcap"]), "run.v5.mcap")
    assertEquals(versionedName("run.v2.mcap", ["run.mcap", "run.v3.mcap"]), "run.v4.mcap")
    // another base or extension doesn't count
    assertEquals(versionedName("run.mcap", ["run.v7.db", "runs.v9.mcap", "other.v3.mcap"]), "run.v2.mcap")
})

const stream = (name: string, count: number, start: number, end: number) => ({
    name,
    type: "nav_msgs.Odometry",
    count,
    start,
    end,
})

Deno.test("change detection: topics, counts and first/last times, not stream order or float noise", () => {
    const before = topicSummary({ streams: [stream("odom", 100, 1.0, 10.0), stream("tf", 50, 1.0, 10.0)] as never })
    const reordered = topicSummary({
        streams: [stream("tf", 50, 1.0000001, 10.0), stream("odom", 100, 1.0, 10.0000002)] as never,
    })
    assertEquals(summaryChanges(before, reordered), [])
    const edited: TopicSummary = topicSummary({
        streams: [stream("odom", 90, 1.0, 10.0), stream("tf", 50, 1.0, 9.0), stream("cam", 5, 1.0, 2.0)] as never,
    })
    assertEquals(summaryChanges(before, edited), [
        "odom: 100 → 90 messages",
        "tf: its first or last message moved",
        "cam: added",
    ])
    assertEquals(summaryChanges(before, topicSummary({ streams: [stream("odom", 100, 1, 10)] as never })), [
        "tf: removed",
    ])

    const entry: GatewayEntry = {
        path: "/r/a.mcap",
        uploadId: "u1",
        link: null,
        changed: true,
        uploadedAt: 1,
        size: 10,
        mtimeMs: 5,
    }
    const baseline: Baseline = { recording: "/r/a.mcap", summary: before, size: 10, mtimeMs: 5, at: 1 }
    // a touched file (the gateway's size+mtime says changed) with the same streams is unchanged
    assertEquals(judge(entry, baseline, reordered), { changed: false, changedBy: "summary", changes: [] })
    assertEquals(judge(entry, baseline, edited).changed, true)
    // no summary from upload time, or one of a different file than went up: the gateway's check
    assertEquals(judge(entry, undefined, edited), { changed: true, changedBy: "size+mtime", changes: [] })
    assertEquals(judge(entry, { ...baseline, size: 11 }, reordered).changedBy, "size+mtime")
    assertEquals(judge(entry, baseline, null).changedBy, "size+mtime")
})

/** Desktop's /dimos-gateway/cloud/uploads, finishing each upload at once; byPath's `changed` is size + mtime */
function fakeDesktop() {
    const uploads: { id: string; path: string; name: string; state: string }[] = []
    const byPath: Record<string, Omit<GatewayEntry, "changed">> = {}
    let next = 0
    const finish = (path: string) => {
        const stat = Deno.statSync(path)
        next++
        uploads.push({ id: `u${next}`, path, name: basename(path), state: "done" })
        byPath[path] = {
            path,
            uploadId: `cloud${next}`,
            link: null,
            uploadedAt: Date.now() + next,
            size: stat.size,
            mtimeMs: stat.mtime!.getTime(),
        }
        return uploads.at(-1)!
    }
    const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
        const url = new URL(request.url)
        if (url.pathname === "/dimos-gateway/cloud/account") {
            return Response.json({ loggedIn: true })
        }
        if (url.pathname !== "/dimos-gateway/cloud/uploads") {
            return new Response("not found", { status: 404 })
        }
        if (request.method === "POST") {
            return Response.json(finish((await request.json()).path))
        }
        const checked = Object.fromEntries(
            Object.entries(byPath).map(([path, entry]) => {
                const stat = Deno.statSync(path)
                return [path, {
                    ...entry,
                    changed: stat.size !== entry.size || stat.mtime!.getTime() !== entry.mtimeMs,
                }]
            }),
        )
        return Response.json({ uploads, byPath: checked, waitingForLogin: false })
    })
    return { url: `http://127.0.0.1:${server.addr.port}`, server, finish, uploads }
}

const tf = (count: number) => ({
    name: "tf",
    payload: "dimos.msgs.tf2_msgs.TFMessage.TFMessage",
    times: range(1_780_000_000, count, 0.5),
    blob: () => lcmTf("map", "odom"),
})

/** appends messages to a .db's tf stream: what an edit that changes the summary does */
function appendTf(path: string, times: number[]) {
    const db = new DatabaseSync(path)
    for (const ts of times) {
        const { lastInsertRowid } = db.prepare(`INSERT INTO "tf" (ts) VALUES (?)`).run(ts)
        db.prepare(`INSERT INTO "tf_blob" VALUES (?, ?)`).run(lastInsertRowid, lcmTf("map", "odom"))
    }
    db.close()
}

Deno.test({
    name:
        "api: upload → unchanged → edit → re-upload as v2 → v3 next; older uploads judged by size+mtime or backfilled",
    // CloudPreviews looks at finished uploads in the background (a .db never gets one)
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const desktop = fakeDesktop()
        const dir = await tempDir()
        for (const name of ["a.db", "b.db", "c.db"]) {
            writeDb(join(dir, name), [tf(10)])
        }
        const routes = buildRoutes(makeServices({
            recordingsDir: dir,
            dataDir: await tempDir(),
            desktopUrl: desktop.url,
            appName: "dim-recordings",
        }))
        const call = async (method: string, path: string, body?: unknown) => {
            const response = await handle(
                new Request(`http://app/${path}`, {
                    method,
                    body: body === undefined ? undefined : JSON.stringify(body),
                }),
                routes,
                INFO,
            )
            return { status: response!.status, body: await response!.json() }
        }
        try {
            assertEquals((await call("GET", "api/recordings/a.db")).body.uploaded, null)
            assertEquals((await call("POST", "api/recordings/a.db/reupload", {})).status, 400)
            assertEquals((await call("POST", "api/recordings/a.db/upload", {})).status, 200)
            let a = (await call("GET", "api/recordings/a.db")).body.uploaded
            assertEquals([a.name, a.changed, a.changedBy, a.nextName], ["a.db", false, "summary", "a.v2.db"])
            assertEquals((await call("POST", "api/recordings/a.db/reupload", {})).status, 409)

            appendTf(join(dir, "a.db"), [1_790_000_000, 1_790_000_001])
            a = (await call("GET", "api/recordings/a.db")).body.uploaded
            assertEquals([a.changed, a.changedBy, a.changes], [true, "summary", ["tf: 10 → 12 messages"]])
            const again = await call("POST", "api/recordings/a.db/reupload", {})
            assertEquals([again.status, again.body.name], [200, "a.v2.db"])
            // it went up through a symlink by the new name; the first upload is still there
            const link = again.body.path as string
            assertEquals(basename(link), "a.v2.db")
            assertEquals(Deno.realPathSync(link), Deno.realPathSync(join(dir, "a.db")))
            assert(desktop.uploads.some((u) => u.path === join(dir, "a.db")))
            a = (await call("GET", "api/recordings/a.db")).body.uploaded
            assertEquals([a.name, a.changed, a.nextName], ["a.v2.db", false, "a.v3.db"])
            // the tray says which recording a vN upload is
            const tray = (await call("GET", "api/uploads")).body
            assertEquals(tray.uploads.find((u: { path: string }) => u.path === link).recording, join(dir, "a.db"))
            // forced while unchanged: v3
            assertEquals((await call("POST", "api/recordings/a.db/reupload", { force: true })).body.name, "a.v3.db")

            // uploaded before summaries were kept, and untouched since: backfilled, so a mere touch isn't a change
            desktop.finish(join(dir, "b.db"))
            let b = (await call("GET", "api/recordings/b.db")).body.uploaded
            assertEquals([b.changed, b.changedBy], [false, "summary"])
            await Deno.utime(join(dir, "b.db"), new Date(), new Date(Date.now() + 5000))
            b = (await call("GET", "api/recordings/b.db")).body.uploaded
            assertEquals([b.changed, b.bytesChanged, b.changedBy], [false, true, "summary"])

            // uploaded before summaries were kept, then edited: only the gateway's size + mtime can say
            desktop.finish(join(dir, "c.db"))
            appendTf(join(dir, "c.db"), [1_790_000_000])
            const c = (await call("GET", "api/recordings/c.db")).body.uploaded
            assertEquals([c.changed, c.changedBy], [true, "size+mtime"])
        } finally {
            await desktop.server.shutdown()
        }
    },
})

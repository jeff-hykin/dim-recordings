// The HTTP API end to end (no Desktop): list, summary, note, rename, duplicate, delete, the agent manifest.
import { assert, assertEquals } from "@std/assert"
import { join } from "node:path"
import { handle } from "../backend/http.ts"
import { buildRoutes, DESCRIPTION } from "../backend/routes.ts"
import { makeServices } from "../backend/services.ts"
import { lcmTf, range, tempDir, writeDb } from "./fixtures.ts"

async function app() {
    const dir = await tempDir()
    writeDb(join(dir, "a.db"), [
        {
            name: "tf",
            payload: "dimos.msgs.tf2_msgs.TFMessage.TFMessage",
            times: range(1_780_000_000, 10, 0.5),
            blob: () => lcmTf("map", "odom"),
        },
    ])
    const services = makeServices({
        recordingsDir: dir,
        dataDir: await tempDir(),
        desktopUrl: "",
        appName: "dim-recordings",
    })
    const routes = buildRoutes(services)
    const call = async (method: string, path: string, body?: unknown) => {
        const response = await handle(
            new Request(`http://app/${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }),
            routes,
            DESCRIPTION,
        )
        return { status: response!.status, body: await response!.json() }
    }
    return { dir, call }
}

Deno.test("api: list → summary → note → rename → duplicate → delete", async () => {
    const { dir, call } = await app()
    let list = await call("GET", "api/recordings?sort=size&order=asc")
    assertEquals(list.status, 200)
    assertEquals(list.body.sections[0].recordings.map((r: { id: string }) => r.id), ["a.db"])
    const one = await call("GET", "api/recordings/a.db")
    assertEquals(one.body.inspection.tf.edges[0].child, "odom")
    // once read, a row carries how many warnings its summary has (the list's flag)
    list = await call("GET", "api/recordings")
    assertEquals(list.body.sections[0].recordings[0].warnings, one.body.inspection.warnings.length)
    assertEquals(one.body.opens[0].target, "replayer") // Foxglove too when this machine has it (disabled for a .db)
    assertEquals((await call("PUT", "api/recordings/a.db/note", { text: "hello" })).status, 200)
    const renamed = await call("POST", "api/recordings/a.db/rename", { name: "b" })
    assertEquals(renamed.body.id, "b.db")
    list = await call("GET", "api/recordings")
    assertEquals(
        list.body.sections.flatMap((s: { recordings: { note: string }[] }) => s.recordings.map((r) => r.note)),
        ["hello"],
    )
    assertEquals((await call("POST", "api/recordings/b.db/duplicate", {})).body.id, "b copy.db")
    assertEquals((await call("DELETE", "api/recordings/b%20copy.db")).status, 200)
    assertEquals((await call("GET", "api/recordings/a.db")).status, 404)
    assertEquals((await call("POST", "api/recordings/b.db/convert", { to: "zip" })).status, 400)
    assertEquals((await call("POST", "api/recordings/..%2Fx.db/rename", { name: "y" })).status, 404)
    assert(await Deno.stat(join(dir, "b.db")))
})

Deno.test("api: agent.json lists every route", async () => {
    const { call } = await app()
    const manifest = await call("GET", "agent.json")
    assert(manifest.body.endpoints.length >= 15)
    assert(manifest.body.endpoints.every((e: { description: string }) => e.description.length > 10))
})

// Where the recordings folder comes from: the dimos gateway's `GET history/recordings`, with DIMOS_APP's recordingsDir
// as the offline fallback — and never DIMOS_HOME (an app knows nothing of Desktop's layout).
import { assert, assertEquals } from "@std/assert"
import { gatewayRecordingsDir, loadConfig } from "../backend/config.ts"

/** a Desktop whose /gateways/dimos/history/recordings answers `body` (with `status`); counts the requests */
function fakeDesktop(body: unknown, status = 200) {
    const asked: string[] = []
    const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (request) => {
        asked.push(new URL(request.url).pathname)
        return new Response(typeof body === "string" ? body : JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
        })
    })
    return { url: `http://127.0.0.1:${server.addr.port}`, server, asked }
}

Deno.test("recordings folder: the gateway's answer, and nothing when it can't say", async () => {
    let desktop = fakeDesktop({ path: "/srv/recordings" })
    try {
        assertEquals(await gatewayRecordingsDir(desktop.url), "/srv/recordings")
        // a trailing slash in DIMOS_APP's desktopUrl is stripped before this, so one path is asked for
        assertEquals(desktop.asked, ["/gateways/dimos/history/recordings"])
    } finally {
        await desktop.server.shutdown()
    }
    // no Desktop to ask: not even a request
    assertEquals(await gatewayRecordingsDir(""), undefined)
    // it answered, but not with a folder: the caller falls back
    for (const [body, status] of [[{ path: "" }, 200], [{}, 200], ["not json", 200], [{ path: "/x" }, 503]] as const) {
        desktop = fakeDesktop(body, status)
        try {
            assertEquals(await gatewayRecordingsDir(desktop.url), undefined)
        } finally {
            await desktop.server.shutdown()
        }
    }
})

Deno.test("config: DIMOS_HOME is not an input (DIMOS_APP and the gateway are the whole story)", async () => {
    const before = Deno.env.get("DIMOS_HOME")
    try {
        Deno.env.set("DIMOS_HOME", "/tmp/dim-recordings-dimos-home-sentinel")
        const config = await loadConfig()
        for (const path of [config.recordingsDir, config.dataDir]) {
            assert(!path.includes("sentinel"), `${path} came from DIMOS_HOME`)
        }
    } finally {
        before === undefined ? Deno.env.delete("DIMOS_HOME") : Deno.env.set("DIMOS_HOME", before)
    }
})

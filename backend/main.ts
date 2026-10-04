// dimos-app-server: this app's API and its built frontend on the unix socket Desktop gives (--socket), else a port.
// Desktop's flags and env: dimos-desktop docs/apps.md (DIMOS_RECORDINGS_DIR, DIMOS_APP_DATA, --desktop-url).
import { loadConfig } from "./config.ts"
import { eventsSocket, handle, publishEvent } from "./http.ts"
import { buildRoutes, DESCRIPTION } from "./routes.ts"
import { makeServices } from "./services.ts"

function flag(name: string): string | undefined {
    const index = Deno.args.indexOf(`--${name}`)
    return index === -1 ? undefined : Deno.args[index + 1]
}

const config = loadConfig()
const services = makeServices(config)
const routes = buildRoutes(services)
services.library.listeners.add(publishEvent)
// a new file in the folder: tell the pages, look for preview work
try {
    Deno.mkdirSync(config.recordingsDir, { recursive: true })
    ;(async () => {
        let timer: number | undefined
        for await (const _event of Deno.watchFs(config.recordingsDir, { recursive: true })) {
            clearTimeout(timer)
            timer = setTimeout(() => {
                publishEvent({ type: "recordings", reason: "folder" })
                services.thumbnails.poke()
            }, 800)
        }
    })()
} catch (error) {
    console.error(`not watching ${config.recordingsDir}:`, error)
}
if (!Deno.args.includes("--no-thumbnails")) {
    services.thumbnails.start()
}
console.error(`recordings: ${config.recordingsDir}, data: ${config.dataDir}, desktop: ${config.desktopUrl || "-"}`)

const frontend = flag("frontend") ?? new URL("../frontend/dist", import.meta.url).pathname
const types: Record<string, string> = {
    html: "text/html; charset=utf-8",
    js: "text/javascript",
    css: "text/css",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    json: "application/json",
    woff2: "font/woff2",
    wasm: "application/wasm",
}

async function file(path: string): Promise<Response> {
    const clean = path.split("/").filter((part) => part && part !== "..").join("/") || "index.html"
    for (const candidate of [clean, "index.html"]) {
        try {
            const bytes = await Deno.readFile(`${frontend}/${candidate}`)
            const type = types[candidate.split(".").pop() ?? ""] ?? "application/octet-stream"
            return new Response(bytes, { headers: { "content-type": type } })
        } catch {
            // next candidate: unknown paths get the app (hash routing)
        }
    }
    return new Response("not found", { status: 404 })
}

async function serve(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path === "/api/events/ws") {
        return eventsSocket(request)
    }
    return (await handle(request, routes, DESCRIPTION)) ?? file(path)
}

const socket = flag("socket")
if (socket) {
    try {
        Deno.removeSync(socket)
    } catch {
        // not there
    }
    Deno.serve({ path: socket, transport: "unix", onListen: () => console.error(`listening on ${socket}`) }, serve)
} else {
    Deno.serve({ port: Number(flag("port") ?? 8787) }, serve)
}

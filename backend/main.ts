// dimos-app-server: this app's API and its built frontend on the unix socket Desktop gives, else a port. What Desktop
// passes: the DIMOS_APP env var, one JSON object (dimos-desktop docs/apps.md; dimos_app.ts, older Desktops' flags as
// fallback).
import { loadConfig } from "./config.ts"
import { dimosApp } from "./dimos_app.ts"
import { handle, publishEvent, stateChanged } from "./http.ts"
import { buildRoutes, DESCRIPTION } from "./routes.ts"
import { makeServices } from "./services.ts"

function flag(name: string): string | undefined {
    const index = Deno.args.indexOf(`--${name}`)
    return index === -1 ? undefined : Deno.args[index + 1]
}

const config = loadConfig()
const services = makeServices(config)
const routes = buildRoutes(services)
// pages: the list is state ("recordings": they re-GET api/recordings), the rest are events (frontend topic `events`)
services.library.listeners.add((event) => {
    const jobMoved = event.type === "job" && (event.job as { state?: string })?.state !== "running"
    if (event.type === "recordings" || event.type === "thumbnail" || jobMoved) {
        stateChanged("recordings")
    }
    if (
        event.type === "thumbnail" ||
        (event.type === "transfer" && (event.transfer as { state?: string })?.state !== "running")
    ) {
        stateChanged("drives")
    }
    if (event.type !== "recordings") {
        publishEvent(event)
    }
})
// a new file in the folder: tell the pages, look for preview work
try {
    Deno.mkdirSync(config.recordingsDir, { recursive: true })
    ;(async () => {
        let timer: number | undefined
        for await (const _event of Deno.watchFs(config.recordingsDir, { recursive: true })) {
            clearTimeout(timer)
            timer = setTimeout(() => {
                stateChanged("recordings")
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
// plugged-in drives: the transfer dialog's list follows them (state/drives), and their recordings get previews
services.drives.onChange = () => {
    stateChanged("drives")
    services.thumbnails.poke()
}
if (!Deno.args.includes("--no-drives")) {
    services.drives.start()
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
    return (await handle(request, routes, DESCRIPTION)) ?? file(path)
}

const socket = dimosApp.socket
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

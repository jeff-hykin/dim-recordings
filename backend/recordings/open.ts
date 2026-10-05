// "Open" targets for a row, and opening. A .db/.mcap: the Replayer (this app, always), the Map Editor (when the
// dim-map-builder app is installed), Foxglove (when installed; enabled only for an .mcap it can draw). An .rrd: the
// Rerun app (dim-rerun) when installed, else the `rerun` viewer on PATH, else disabled with the reason.
import type { Config } from "../config.ts"
import { findFoxglove, foxgloveVerdict, which } from "./foxglove.ts"
import type { Inspection } from "./inspect.ts"

export type OpenTarget = {
    target: "replayer" | "map-editor" | "foxglove" | "rerun"
    label: string
    ok: boolean
    reason: string
}

export type Environment = {
    /** installed Desktop app names */
    apps: string[]
    foxglove: boolean
    rerunCli: boolean
}

export const MAP_EDITOR_APP = "dim-map-builder"
export const RERUN_APP = "dim-rerun"

export function openTargets(format: string, inspection: Inspection | null, env: Environment): OpenTarget[] {
    if (format === "rrd") {
        if (env.apps.includes(RERUN_APP)) {
            return [{ target: "rerun", label: "Rerun", ok: true, reason: "in the Rerun app" }]
        }
        if (env.rerunCli) {
            return [{ target: "rerun", label: "Rerun", ok: true, reason: "in the rerun viewer (a new window)" }]
        }
        return [{
            target: "rerun",
            label: "Rerun",
            ok: false,
            reason: "install the Rerun app (dim-rerun) or the rerun viewer (pip install rerun-sdk) to open .rrd files",
        }]
    }
    const out: OpenTarget[] = [{ target: "replayer", label: "Replayer", ok: true, reason: "play it back here" }]
    if (env.apps.includes(MAP_EDITOR_APP)) {
        out.push({ target: "map-editor", label: "Map Editor", ok: true, reason: "build and edit its map" })
    }
    if (env.foxglove) {
        const verdict = foxgloveVerdict(format, inspection)
        out.push({ target: "foxglove", label: "Foxglove", ok: verdict.ok, reason: verdict.reason })
    }
    return out
}

/** Installed apps (Desktop's GET /api/apps), re-read at most every 10 s. */
let appsCache: { at: number; names: string[] } = { at: 0, names: [] }
export async function installedApps(config: Config): Promise<string[]> {
    if (!config.desktopUrl) {
        return []
    }
    if (Date.now() - appsCache.at < 10_000) {
        return appsCache.names
    }
    try {
        const response = await fetch(`${config.desktopUrl}/api/apps`)
        const body = await response.json() as { apps?: { name: string; stopped?: boolean }[] }
        appsCache = { at: Date.now(), names: (body.apps ?? []).map((app) => app.name) }
    } catch {
        appsCache = { at: Date.now(), names: [] }
    }
    return appsCache.names
}

export async function environment(config: Config): Promise<Environment> {
    return { apps: await installedApps(config), foxglove: !!findFoxglove(), rerunCli: !!which("rerun") }
}

async function desktop(config: Config, path: string, body: unknown) {
    if (!config.desktopUrl) {
        throw new Error("not running in Desktop (no desktopUrl in DIMOS_APP)")
    }
    const response = await fetch(`${config.desktopUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    })
    const text = await response.text()
    if (!response.ok) {
        throw new Error(`${path}: ${response.status} ${text.slice(0, 300)}`)
    }
    return text ? JSON.parse(text) : {}
}

function spawn(command: string[]) {
    const child = new Deno.Command(command[0], {
        args: command.slice(1),
        stdin: "null",
        stdout: "null",
        stderr: "null",
    })
        .spawn()
    child.unref()
}

/** Opens the file in the target; returns what happened, for the page's toast and the agent. `show: false` loads it
 * into another app without switching to it (`app` says which; the page opens it in its own window, so Back returns). */
export async function openIn(
    config: Config,
    target: OpenTarget["target"],
    recording: { id: string; name: string; path: string; format: string; symlink: boolean },
    inspection: Inspection | null,
    show = true,
): Promise<{ ok: true; opened: string; app?: string }> {
    const env = await environment(config)
    const choice = openTargets(recording.format, inspection, env).find((t) => t.target === target)
    if (!choice) {
        throw new Error(`${target} can't open a .${recording.format} here`)
    }
    if (!choice.ok) {
        throw new Error(choice.reason)
    }
    switch (target) {
        case "replayer":
            await desktop(config, "/api/open-app", {
                app: config.appName,
                path: `#/replay/${encodeURIComponent(recording.id)}`,
            })
            return { ok: true, opened: `the Replayer on ${recording.name}` }
        case "map-editor":
            await desktop(config, `/apps/${MAP_EDITOR_APP}/api/open`, {
                id: recording.id,
                name: recording.name,
                path: recording.path,
                writable: !recording.symlink,
            })
            if (show) {
                await desktop(config, "/api/open-app", { app: MAP_EDITOR_APP })
            }
            return { ok: true, opened: `the Map Editor on ${recording.name}`, app: MAP_EDITOR_APP }
        case "foxglove":
            spawn([...findFoxglove()!.command, recording.path])
            return { ok: true, opened: `Foxglove on ${recording.name}` }
        case "rerun":
            if (env.apps.includes(RERUN_APP)) {
                await desktop(config, `/apps/${RERUN_APP}/api/open`, { path: recording.path })
                if (show) {
                    await desktop(config, "/api/open-app", { app: RERUN_APP })
                }
                return { ok: true, opened: `the Rerun app on ${recording.name}`, app: RERUN_APP }
            }
            spawn([which("rerun")!, recording.path])
            return { ok: true, opened: `rerun on ${recording.name}` }
    }
}

/** Shows the file in Finder / the file manager. */
export function reveal(path: string) {
    if (Deno.build.os === "darwin") {
        spawn(["open", "-R", path])
    } else {
        spawn([which("xdg-open") ?? "xdg-open", path.slice(0, path.lastIndexOf("/")) || "/"])
    }
}

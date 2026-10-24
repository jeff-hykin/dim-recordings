// Where things are: what Desktop passes in DIMOS_APP (docs/apps.md; dimos_app.ts) and, for the recordings folder, the
// dimos gateway's own answer, with fallbacks for running outside Desktop (--recordings-dir, --data-dir,
// --desktop-url). Nothing here reads DIMOS_HOME or looks inside it: Desktop's layout is Desktop's business, and
// DIMOS_APP plus its HTTP API is everything an app is told.
import { join } from "node:path"
import { dimosApp } from "./dimos_app.ts"

function flag(name: string): string | undefined {
    const index = Deno.args.indexOf(`--${name}`)
    return index === -1 ? undefined : Deno.args[index + 1]
}

const home = Deno.env.get("HOME") ?? "."
const dataHome = Deno.env.get("XDG_DATA_HOME") ?? join(home, ".local", "share")

export type Config = {
    /** the shared recordings folder (the dimos gateway's `history/recordings`, which is also what a run records into) */
    recordingsDir: string
    /** this app's own files: notes, thumbnails, the inspection cache (never inside a recording) */
    dataDir: string
    /** Desktop's HTTP base, for /gateways/dimos/..., /gateways/desktop/... and other apps' endpoints; "" outside Desktop */
    desktopUrl: string
    /** this app's name in Desktop (its {pkg} in /gateways/desktop/ui/apps/{pkg}/open) */
    appName: string
}

/** The folder dimos records into, asked of the dimos gateway (`GET history/recordings` → `{path}`): one resolver on
 * dimos's side answers this and every run's --record-dir, so the answer is where the files actually land. undefined
 * when there is no Desktop to ask or it can't say. */
export async function gatewayRecordingsDir(desktopUrl: string): Promise<string | undefined> {
    if (!desktopUrl) {
        return undefined
    }
    try {
        const response = await fetch(`${desktopUrl}/gateways/dimos/history/recordings`, {
            signal: AbortSignal.timeout(10_000),
        })
        const text = await response.text()
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${text.slice(0, 200)}`)
        }
        const { path } = JSON.parse(text) as { path?: unknown }
        if (typeof path === "string" && path) {
            return path
        }
        throw new Error(`no path in ${text.slice(0, 200)}`)
    } catch (error) {
        // the folder DIMOS_APP named at start is the offline answer
        console.error(`asking the dimos gateway where recordings go: ${error instanceof Error ? error.message : error}`)
        return undefined
    }
}

export async function loadConfig(): Promise<Config> {
    const desktopUrl = (flag("desktop-url") ?? dimosApp.desktopUrl ?? "").replace(/\/+$/, "")
    return {
        recordingsDir: flag("recordings-dir") ?? await gatewayRecordingsDir(desktopUrl) ?? dimosApp.recordingsDir ??
            join(home, "recordings"),
        dataDir: flag("data-dir") ?? dimosApp.dataDir ?? join(dataHome, "dim-recordings"),
        desktopUrl,
        appName: dimosApp.name ?? "dim-recordings",
    }
}

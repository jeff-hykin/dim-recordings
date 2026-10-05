// Where things are: what Desktop passes in DIMOS_APP (docs/apps.md; dimos_app.ts), with fallbacks for running outside
// Desktop (--recordings-dir, --data-dir, --desktop-url).
import { join } from "node:path"
import { dimosApp } from "./dimos_app.ts"

function flag(name: string): string | undefined {
    const index = Deno.args.indexOf(`--${name}`)
    return index === -1 ? undefined : Deno.args[index + 1]
}

const home = Deno.env.get("HOME") ?? "."
const dimosHome = Deno.env.get("DIMOS_HOME") ?? join(home, ".dimos")

export type Config = {
    /** the shared recordings folder (Desktop's `recordings.dir`) */
    recordingsDir: string
    /** this app's own files: notes, thumbnails, the inspection cache (never inside a recording) */
    dataDir: string
    /** Desktop's HTTP base, for /api/apps, /api/open-app and other apps' endpoints; "" outside Desktop */
    desktopUrl: string
    /** this app's name in Desktop (what /api/open-app calls it) */
    appName: string
}

export function loadConfig(): Config {
    return {
        recordingsDir: flag("recordings-dir") ?? dimosApp.recordingsDir ?? join(dimosHome, "recordings"),
        dataDir: flag("data-dir") ?? dimosApp.dataDir ?? join(dimosHome, "data", "apps", "dim-recordings"),
        desktopUrl: (dimosApp.desktopUrl ?? "").replace(/\/+$/, ""),
        appName: dimosApp.name ?? "dim-recordings",
    }
}

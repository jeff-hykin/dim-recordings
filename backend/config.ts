// Where things are: Desktop's flags (docs/apps.md) and env, with fallbacks for running outside Desktop.
import { join } from "node:path"

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
        recordingsDir: flag("recordings-dir") ?? Deno.env.get("DIMOS_RECORDINGS_DIR") ?? join(dimosHome, "recordings"),
        dataDir: flag("data-dir") ?? Deno.env.get("DIMOS_APP_DATA") ??
            join(dimosHome, "data", "apps", "dim-recordings"),
        desktopUrl: (flag("desktop-url") ?? Deno.env.get("DIMOS_DESKTOP_URL") ?? "").replace(/\/+$/, ""),
        appName: Deno.env.get("DIMOS_APP_NAME") ?? "dim-recordings",
    }
}

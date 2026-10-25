// What dimOS Desktop tells this server at start: the DIMOS_APP env var, one JSON object and the whole interface
// (docs/apps.md in dimos-desktop).

export type DimosApp = {
    version: number | null
    name: string | null
    socket: string | null
    url: string | null
    path: string | null
    dataDir: string | null
    desktopUrl: string | null
    zenohGatewayUrl: string | null
    zenohConnect: string | null
    zenohNamespace: string | null
    zenohPrefix: string | null
    dimosDir: string | null
    dimosPython: string | null
    recordingsDir: string | null
    /** names this machine in a recording's metadata; Desktop 0.2.226 and newer */
    machineId: string | null
    /** this app's secrets (its zenohGatewayToken among them): never print it, never pass it on */
    secrets: Record<string, string> | null
}

const EMPTY: DimosApp = {
    version: null,
    name: null,
    socket: null,
    url: null,
    path: null,
    dataDir: null,
    desktopUrl: null,
    zenohGatewayUrl: null,
    zenohConnect: null,
    zenohNamespace: null,
    zenohPrefix: null,
    dimosDir: null,
    dimosPython: null,
    recordingsDir: null,
    machineId: null,
    secrets: null,
}

/** DIMOS_APP's fields; one it lacks (or all of them, run outside Desktop) is null. */
export function readDimosApp(): DimosApp {
    const json = Deno.env.get("DIMOS_APP")
    return { ...EMPTY, ...(json ? JSON.parse(json) : {}) }
}

/** `DIMOS_APP` with its `secrets` left out: what may be printed. */
export function loggable(app: DimosApp): Omit<DimosApp, "secrets"> {
    const { secrets: _secrets, ...rest } = app
    return rest
}

/** DIMOS_APP, read once; logged once so the App Store's log shows it, without the secrets in it. */
export const dimosApp: DimosApp = readDimosApp()
if (Deno.env.get("DIMOS_APP")) {
    // Desktop also redacts the zenoh-gateway token out of the log it serves, because apps used to print the whole
    // object. `secrets` is the section that makes that unnecessary: it is skipped here, whatever is in it.
    console.error(`DIMOS_APP: ${JSON.stringify(loggable(dimosApp))}`)
}

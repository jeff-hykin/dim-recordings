// Every route the backend serves, by module. `routes` is also served as openapi.json, and dimos.yaml's `provides:`
// repeats it (`deno task check-endpoints` keeps the two in step; CI runs it).
import type { Info, Route } from "./http.ts"
import { driveRoutes } from "./recordings/drive_routes.ts"
import { recordingRoutes, type Services } from "./recordings/routes.ts"
import { replayRoutes } from "./replay/routes.ts"

export const INFO: Info = {
    title: "Recordings",
    version: "1.0.0",
    description:
        "Recordings: the robot recordings in Desktop's recordings folder (.db memory2 SQLite, .mcap, and the .rrd " +
        "files made from them): list and sort them, inspect their streams and tf tree, keep notes, preview their " +
        "main camera, rename, delete, duplicate, convert between formats, open them (Replayer, Map Editor, " +
        "Foxglove, Rerun), upload them to the Dimensional cloud, and bring recordings in from a plugged-in USB " +
        "drive (GET api/drives, POST api/drives/transfer). GET api/recordings is the overview.",
}

export function buildRoutes(services: Services): Route[] {
    return [...recordingRoutes(services), ...driveRoutes(services), ...replayRoutes(services)]
}

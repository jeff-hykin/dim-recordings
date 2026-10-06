// Every route the backend serves, by module. `routes` is also served as agent.json, and dimos.yaml's `agent:` repeats
// it (`deno task check-endpoints` keeps the two in step; CI runs it).
import type { Route } from "./http.ts"
import { driveRoutes } from "./recordings/drive_routes.ts"
import { recordingRoutes, type Services } from "./recordings/routes.ts"
import { replayRoutes } from "./replay/routes.ts"

export const DESCRIPTION =
    "Recordings: the robot recordings in Desktop's recordings folder (.db memory2 SQLite, .mcap, and the .rrd files made " +
    "from them): list and sort them, inspect their streams and tf tree, keep notes, preview their main camera, rename, " +
    "delete, duplicate, convert between formats, open them (Replayer, Map Editor, Foxglove, Rerun), upload them to the " +
    "Dimensional cloud, and bring recordings in from a plugged-in USB drive (GET api/drives, POST api/drives/transfer). " +
    "GET api/recordings is the overview."

export function buildRoutes(services: Services): Route[] {
    return [...recordingRoutes(services), ...driveRoutes(services), ...replayRoutes(services)]
}

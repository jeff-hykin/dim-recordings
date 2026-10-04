// The Replayer's backend lives here (its page is the `#/replay/<id>` view). Add its routes to this list; they get
// the same services as the recordings routes (the Library resolves ids to files).
import type { Route } from "../http.ts"
import type { Services } from "../recordings/routes.ts"

export function replayRoutes(_services: Services): Route[] {
    return []
}

// Hash routes: `#/` the library, `#/transfer` the library with the transfer dialog open (Desktop's "Transfer
// recordings" notification opens this), `#/replay/<id>` the Replayer (views/Replay.tsx).
import { lazy, Suspense, useEffect, useState } from "react"
import { Button, EmptyState, ErrorBoundary } from "dimos-react"
import { Library } from "./views/Library.tsx"
import { api } from "./api.ts"
import { readExtraDirs } from "./extra_dirs.ts"

// the Replayer (three.js) loads only when a recording is opened in it
const Replay = lazy(() => import("./views/Replay.tsx").then((module) => ({ default: module.Replay })))

export type Route = { view: "library"; transfer?: boolean } | {
    view: "replay"
    id: string
}

export function parseRoute(hash: string): Route {
    const match = hash.match(/^#\/replay\/(.+)$/)
    if (match) {
        return { view: "replay", id: decodeURIComponent(match[1]) }
    }
    return /^#\/transfer\/?$/.test(hash) ? { view: "library", transfer: true } : { view: "library" }
}

export function go(route: Route) {
    location.hash = route.view === "replay"
        ? `#/replay/${encodeURIComponent(route.id)}`
        : route.transfer
        ? "#/transfer"
        : "#/"
}

export function App() {
    const [route, setRoute] = useState(parseRoute(location.hash))
    // the backend learns this page's extra folders before the Replayer asks for a recording from one of them
    const [dirsSent, setDirsSent] = useState(false)
    useEffect(() => {
        api.setExtraDirs(readExtraDirs()).catch(() => {}).finally(() => setDirsSent(true))
    }, [])
    useEffect(() => {
        const update = () => setRoute(parseRoute(location.hash))
        addEventListener("hashchange", update)
        return () => removeEventListener("hashchange", update)
    }, [])
    // a view that throws says so, and the next route starts clean (React would otherwise unmount the app)
    return (
        <ErrorBoundary
            key={JSON.stringify(route)}
            fallback={({ error }) => (
                <EmptyState
                    layer
                    icon="warn"
                    tone="warn"
                    title="Something went wrong"
                    message={error instanceof Error ? error.message : String(error)}
                    actions={
                        <Button
                            variant="primary"
                            onClick={() => go({ view: "library" })}
                        >
                            Back to the recordings
                        </Button>
                    }
                />
            )}
        >
            {route.view === "replay"
                ? dirsSent && (
                    <Suspense fallback={null}>
                        <Replay id={route.id} />
                    </Suspense>
                )
                : <Library transfer={!!route.transfer} />}
        </ErrorBoundary>
    )
}

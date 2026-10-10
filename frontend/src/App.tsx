// Hash routes: `#/` the library, `#/transfer` the library with the transfer dialog open (Desktop's "Transfer
// recordings" notification opens this), `#/replay/<id>` the Replayer (views/Replay.tsx).
import { lazy, Suspense, useEffect, useState } from "react"
import { Library } from "./views/Library.tsx"
import { Toasts } from "./ui.tsx"
import { EmptyState } from "./EmptyState.tsx"
import { ViewBoundary } from "./ViewBoundary.tsx"

// the Replayer (three.js, the Controller's view) loads only when a recording is opened in it; its styles then come
// after the theme's, as they do in the Controller
const Replay = lazy(() => import("./views/Replay.tsx").then((module) => ({ default: module.Replay })))

export type Route = { view: "library"; transfer?: boolean } | { view: "replay"; id: string }

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
    useEffect(() => {
        const update = () => setRoute(parseRoute(location.hash))
        addEventListener("hashchange", update)
        return () => removeEventListener("hashchange", update)
    }, [])
    return (
        <>
            {/* a view that throws says so, and the next route starts clean (React would otherwise unmount the app) */}
            <ViewBoundary
                resetKey={JSON.stringify(route)}
                fallback={(failure) => (
                    <EmptyState
                        title="Something went wrong"
                        tone="warn"
                        body={failure.message}
                        actions={[{ label: "Back to the recordings", onClick: () => go({ view: "library" }) }]}
                    />
                )}
            >
                {route.view === "replay"
                    ? (
                        <Suspense fallback={null}>
                            <Replay id={route.id} />
                        </Suspense>
                    )
                    : <Library transfer={!!route.transfer} />}
            </ViewBoundary>
            <Toasts />
        </>
    )
}

// Hash routes: `#/` the library, `#/replay/<id>` the Replayer (views/Replay.tsx).
import { lazy, Suspense, useEffect, useState } from "react"
import { Library } from "./views/Library.tsx"
import { Toasts } from "./ui.tsx"

// the Replayer (three.js, the Controller's view) loads only when a recording is opened in it; its styles then come
// after the theme's, as they do in the Controller
const Replay = lazy(() => import("./views/Replay.tsx").then((module) => ({ default: module.Replay })))

export type Route = { view: "library" } | { view: "replay"; id: string }

export function parseRoute(hash: string): Route {
    const match = hash.match(/^#\/replay\/(.+)$/)
    return match ? { view: "replay", id: decodeURIComponent(match[1]) } : { view: "library" }
}

export function go(route: Route) {
    location.hash = route.view === "replay" ? `#/replay/${encodeURIComponent(route.id)}` : "#/"
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
            {route.view === "replay"
                ? (
                    <Suspense fallback={null}>
                        <Replay id={route.id} />
                    </Suspense>
                )
                : <Library />}
            <Toasts />
        </>
    )
}

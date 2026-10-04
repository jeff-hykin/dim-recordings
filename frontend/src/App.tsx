// Hash routes: `#/` the library, `#/replay/<id>` the Replayer (views/Replay.tsx).
import { useEffect, useState } from "react"
import { Library } from "./views/Library.tsx"
import { Replay } from "./views/Replay.tsx"
import { Toasts } from "./ui.tsx"

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
            {route.view === "replay" ? <Replay id={route.id} /> : <Library />}
            <Toasts />
        </>
    )
}

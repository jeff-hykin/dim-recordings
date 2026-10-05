// React bindings: useBackendState, snapshot + live backend state (backend_state.js). Imports "react" from the app.
//
//     import { useBackendState } from "./dim-app/react.js"
//     const [recordings, { loading, error, refresh }] = useBackendState("recordings") // GET api/state/recordings
//     const [library] = useBackendState("api/library", { key: "library" })            // re-GET on state/library events

import { useCallback, useEffect, useRef, useState } from "react"
import { watchBackendState } from "./backend_state.js"

/**
 * @param {string} source a key ("recordings" → GET api/state/recordings) or an app-relative URL
 * @param {{ key?: string, url?: string, topic?: string, debounceMs?: number, initial?: any }} [options] read once, when
 *   `source` changes
 * @returns {[any, { loading: boolean, error: Error | null, version: number | null, refresh: () => Promise<void> }]}
 */
export function useBackendState(source, options = {}) {
    const [snapshot, setSnapshot] = useState({ data: options.initial, loading: true, error: null, version: null })
    const watch = useRef(null)
    const optionsRef = useRef(options)
    optionsRef.current = options
    useEffect(() => {
        if (!source) {
            return
        }
        const { initial: _initial, ...watchOptions } = optionsRef.current
        const watcher = watchBackendState(source, setSnapshot, watchOptions)
        watch.current = watcher
        return () => {
            watcher.stop()
            if (watch.current === watcher) {
                watch.current = null
            }
        }
    }, [source])
    const refresh = useCallback(() => watch.current?.refresh() ?? Promise.resolve(), [])
    return [snapshot.data, { loading: snapshot.loading, error: snapshot.error, version: snapshot.version, refresh }]
}

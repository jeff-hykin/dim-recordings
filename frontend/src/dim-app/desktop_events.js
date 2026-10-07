// Desktop → app events (Desktop's docs/events.md): Desktop publishes each event on `<ns>/desktop/events/<type>` (typed by
// its `type`: apps, endpoints, blueprints, runs, notification, notifications, ui-settings, recordings, job, error, …),
// and the dimos server's on `<ns>/dimos/events/<type>`.
//
//     import { onDesktopEvent } from "https://esm.sh/gh/jeff-hykin/dim-app@v0.17.0/desktop_events.js"
//     const off = onDesktopEvent("endpoints", (event) => refreshTools())   // or "*" for every event
//     off()                                                                // unsubscribe
//
// Browser: a subscription on the page's one zenoh-gateway connection (zenoh.js's getZenoh()). Events published while that
// connection was down are gone; `onDesktopReconnect(callback)` says when to re-GET. Deno (an app's backend, which has
// no zenoh-gateway): Desktop's deprecated `GET /api/events` stream from DIMOS_APP's desktopUrl (Server-Sent Events, kept by
// Desktop for one release), reconnecting with backoff (0.5 s doubling to 10 s). Never throws.

import { getZenoh } from "./zenoh.js"

const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 10_000

/** @type {Map<string, Set<(event: any) => void>>} type ("*" = all) → callbacks */
const subscribers = new Map()
/** @type {null | { close(): void }} */
let connection = null

/**
 * An incremental SSE parser: feed it text chunks, it calls `onData(dataString)` once per complete event (multiple
 * `data:` lines joined with "\n"; comments, `event:`, `id:`, `retry:` lines ignored).
 * @param {(data: string) => void} onData
 * @returns {(chunk: string) => void}
 */
export function sseParser(onData) {
    let buffer = ""
    /** @type {string[]} */
    let data = []
    return (chunk) => {
        buffer += chunk
        let newline
        while ((newline = buffer.search(/\r\n|\r|\n/)) !== -1) {
            const line = buffer.slice(0, newline)
            buffer = buffer.slice(newline + (buffer.startsWith("\r\n", newline) ? 2 : 1))
            if (line === "") {
                if (data.length) {
                    onData(data.join("\n"))
                    data = []
                }
            } else if (line.startsWith("data:")) {
                data.push(line.slice(line[5] === " " ? 6 : 5))
            }
        }
    }
}

function dispatch(raw) {
    let event
    try {
        event = JSON.parse(raw)
    } catch {
        return
    }
    const callbacks = [...(subscribers.get(event?.type) ?? []), ...(subscribers.get("*") ?? [])]
    for (const callback of callbacks) {
        try {
            callback(event)
        } catch (error) {
            console.error("[dim-app] onDesktopEvent callback:", error)
        }
    }
}

function desktopUrlFromServer() {
    const ctx = globalThis[Symbol.for("dim.app")]?.ctx
    if (ctx?.desktopUrl) {
        return ctx.desktopUrl
    }
    try {
        const app = globalThis.Deno?.env.get("DIMOS_APP")
        return (app && JSON.parse(app).desktopUrl) || (globalThis.Deno?.env.get("DIMOS_DESKTOP_URL") ?? null)
    } catch {
        return null
    }
}

function connectFetch(url) {
    let closed = false
    let delay = RECONNECT_MIN_MS
    let controller = null
    let timer = null
    const run = async () => {
        while (!closed) {
            controller = new AbortController()
            try {
                const response = await fetch(url, {
                    headers: { accept: "text/event-stream" },
                    signal: controller.signal,
                })
                if (!response.ok || !response.body) {
                    throw new Error(`HTTP ${response.status}`)
                }
                delay = RECONNECT_MIN_MS
                const feed = sseParser(dispatch)
                const decoder = new TextDecoder()
                for await (const bytes of response.body) {
                    feed(decoder.decode(bytes, { stream: true }))
                }
            } catch {
                // down, refused, or aborted: retry below unless closed
            }
            if (closed) {
                break
            }
            await new Promise((resolve) => (timer = setTimeout(resolve, delay)))
            delay = Math.min(delay * 2, RECONNECT_MAX_MS)
        }
    }
    run()
    return {
        close() {
            closed = true
            clearTimeout(timer)
            controller?.abort()
        },
    }
}

const inBrowser = () => typeof document !== "undefined" && typeof location !== "undefined"

/**
 * Calls `callback(event)` for each Desktop event of `type` ("*" = every event). Returns an unsubscribe function.
 * @param {string} type
 * @param {(event: { type: string, [key: string]: unknown }) => void} callback
 * @param {{ desktopUrl?: string }} [options] Deno only: Desktop's base URL (default: DIMOS_APP's desktopUrl)
 * @returns {() => void}
 */
export function onDesktopEvent(type, callback, options = {}) {
    if (inBrowser() && !options.desktopUrl) {
        try {
            return getZenoh().subscribeDesktop(type, callback)
        } catch (error) {
            console.debug("[dim-app] onDesktopEvent: couldn't subscribe:", error)
            return () => {}
        }
    }
    return onDesktopEventStream(type, callback, options)
}

/** Browser: calls `callback(event)` for each dimos server event of `type` ("*" = every one): launch, log, upload, … */
export function onDimosEvent(type, callback) {
    return getZenoh().subscribeDimos(type, callback)
}

/** Browser: `callback()` when the page's zenoh-gateway connection is back after being lost (re-GET what you show). */
export function onDesktopReconnect(callback) {
    return getZenoh().onReconnect(callback)
}

function onDesktopEventStream(type, callback, options) {
    if (!subscribers.has(type)) {
        subscribers.set(type, new Set())
    }
    subscribers.get(type).add(callback)
    if (!connection) {
        try {
            const base = options.desktopUrl ?? desktopUrlFromServer()
            if (!base) {
                console.debug("[dim-app] onDesktopEvent: no Desktop URL (not under dimOS Desktop); no events")
            } else {
                connection = connectFetch(new URL("/api/events", base).href)
            }
        } catch (error) {
            console.debug("[dim-app] onDesktopEvent: couldn't connect:", error)
        }
    }
    return () => {
        subscribers.get(type)?.delete(callback)
        if (subscribers.get(type)?.size === 0) {
            subscribers.delete(type)
        }
        if (subscribers.size === 0 && connection) {
            connection.close()
            connection = null
        }
    }
}

// Desktop → app events: a subscription to dimOS Desktop's push stream (`GET /api/events`, Server-Sent Events, one JSON
// object per `data:` line, typed by its `type`: apps, endpoints, blueprints, runs, notification, notifications,
// ui-settings, dimos, job, recordings, agent).
//
//     import { onDesktopEvent } from "https://esm.sh/gh/jeff-hykin/dim-app@v0.9.5/desktop_events.js"
//     const off = onDesktopEvent("endpoints", (event) => refreshTools())   // or "*" for every event
//     off()                                                                // unsubscribe
//
// Browser: an EventSource on the same origin ("/api/events"; apps are served under /apps/<name>/). Deno (an app's
// backend): fetches the stream from the Desktop URL its server was given (`--desktop-url`, else DIMOS_DESKTOP_URL),
// parses the `data:` lines, and reconnects with backoff (0.5 s doubling to 10 s). One connection per process/page,
// shared by every subscription; it closes when the last one unsubscribes. Never throws.

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
        return globalThis.Deno?.env.get("DIMOS_DESKTOP_URL") ?? null
    } catch {
        return null
    }
}

function connectBrowser(url) {
    const source = new EventSource(url)
    source.onmessage = (message) => dispatch(message.data) // EventSource reconnects by itself
    return { close: () => source.close() }
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

/**
 * Calls `callback(event)` for each Desktop event of `type` ("*" = every event). Returns an unsubscribe function.
 * @param {string} type
 * @param {(event: { type: string, [key: string]: unknown }) => void} callback
 * @param {{ desktopUrl?: string }} [options] Desktop's base URL; default: same origin (browser) or the server's
 *   --desktop-url / DIMOS_DESKTOP_URL (Deno)
 * @returns {() => void}
 */
export function onDesktopEvent(type, callback, options = {}) {
    if (!subscribers.has(type)) {
        subscribers.set(type, new Set())
    }
    subscribers.get(type).add(callback)
    if (!connection) {
        try {
            const inBrowser = typeof EventSource === "function" && typeof document !== "undefined"
            const base = options.desktopUrl ?? (inBrowser ? location.origin : desktopUrlFromServer())
            if (!base) {
                console.debug("[dim-app] onDesktopEvent: no Desktop URL (not under dimOS Desktop); no events")
            } else {
                const url = new URL("/api/events", base).href
                connection = inBrowser && !options.desktopUrl ? connectBrowser(url) : connectFetch(url)
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

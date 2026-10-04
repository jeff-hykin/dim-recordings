// The Replayer's endpoints (backend/replay/routes.ts).
import type { StreamInfo } from "../live/core/transport.ts"

export type Overview = {
    id: string
    name: string
    format: "db" | "mcap"
    size: number
    editable: boolean
    start: number
    end: number
    streams: StreamInfo[]
    thumbnails: Record<string, number>
}

export type TimelineRow = {
    name: string
    kind: StreamInfo["kind"]
    count: number
    counts: number[]
    times?: number[]
}
export type Timeline = {
    start: number
    end: number
    bins: number
    streams: TimelineRow[]
}

async function call<T>(
    method: string,
    path: string,
    body?: unknown,
): Promise<T> {
    const response = await fetch(path, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    let parsed: unknown = null
    try {
        parsed = text ? JSON.parse(text) : null
    } catch {
        parsed = { error: text }
    }
    if (!response.ok) {
        throw new Error(
            (parsed as { error?: string })?.error ?? `${response.status}`,
        )
    }
    return parsed as T
}

const enc = encodeURIComponent

export const replayApi = {
    overview: (id: string) => call<Overview>("GET", `api/replay/${enc(id)}`),
    timeline: (id: string, bins: number) => call<Timeline>("GET", `api/replay/${enc(id)}/timeline?bins=${bins}`),
    renameStream: (id: string, stream: string, name: string) =>
        call<{ seconds: number }>(
            "POST",
            `api/recordings/${enc(id)}/streams/${enc(stream)}/rename`,
            { name },
        ),
    deleteStream: (id: string, stream: string) =>
        call<{ seconds: number }>(
            "DELETE",
            `api/recordings/${enc(id)}/streams/${enc(stream)}`,
        ),
    duplicateStream: (id: string, stream: string, name?: string) =>
        call<{ seconds: number; to: string }>(
            "POST",
            `api/recordings/${enc(id)}/streams/${enc(stream)}/duplicate`,
            name ? { name } : {},
        ),
}

/** 83.4 → "1:23.4"; over an hour "1:02:03" */
export function clock(seconds: number): string {
    const sign = seconds < 0 ? "-" : ""
    seconds = Math.abs(seconds)
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = seconds % 60
    if (h) {
        return `${sign}${h}:${String(m).padStart(2, "0")}:${String(Math.floor(s)).padStart(2, "0")}`
    }
    return `${sign}${m}:${s.toFixed(1).padStart(4, "0")}`
}

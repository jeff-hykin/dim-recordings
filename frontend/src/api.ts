// The app's backend (relative URLs: the page lives at Desktop's /apps/<name>/) and the shapes it returns.

export type StreamInfo = {
    name: string
    type: string
    encoding: string
    hasSchema: boolean
    count: number
    start: number | null
    end: number | null
    duration: number
    hz: number
    p99Gap: number
    p99Ratio: number
    maxGap: number
    gapRatio: number
}

export type TfEdge = {
    parent: string
    child: string
    count: number
    first: number
    last: number
    /** 0 when static */
    hz: number
    static: boolean
}

export type TfTree = {
    source: string | null
    /** how much of it was read: "all of it", "16 windows of 1 s, every 31 s" */
    coverage: string
    messages: number
    edges: TfEdge[]
    roots: string[]
    conflicts: { frame: string; parents: { parent: string; count: number }[] }[]
}

export type Inspection = {
    format: "db" | "mcap"
    start: number | null
    end: number | null
    duration: number | null
    messages: number
    streams: StreamInfo[]
    tf: TfTree
    /** what looks wrong, worst first (backend/recordings/warnings.ts) */
    warnings: Warning[]
    summary: string
    error?: string
}

export type Warning = {
    kind: string
    message: string
    detail: string
    stream?: string
    frame?: string
    at?: number
}

export type OpenTarget = {
    target: "replayer" | "map-editor" | "foxglove" | "rerun"
    label: string
    ok: boolean
    reason: string
}

export type Thumb =
    | {
        state: "ready"
        frames: number
        width: number
        height: number
        stream: string
    }
    | { state: "none"; reason: string }
    | { state: "pending" }

export type RrdFile = {
    id: string
    name: string
    format: "rrd"
    size: number
    modified: number
    path: string
    symlink: boolean
    opens: OpenTarget[]
}

export type Uploaded = {
    path: string
    uploadId: string
    link: string | null
    changed: boolean
    uploadedAt: number
}

export type Recording = {
    id: string
    name: string
    format: "db" | "mcap" | "rrd"
    size: number
    modified: number
    path: string
    symlink: boolean
    standalone?: boolean
    rrds: RrdFile[]
    recorded: number
    recordedFrom: "messages" | "mtime"
    duration: number | null
    summary: string | null
    note: string
    messages: number | null
    inspected: boolean
    error: string | null
    thumbnail: Thumb
    opens: OpenTarget[]
    conversions: { to: "db" | "mcap" | "rrd"; ok: boolean; reason: string }[]
    uploaded: Uploaded | null
}

export type ListResponse = {
    dir: string
    sort: SortKey
    order: Order
    sections: { label: string | null; recordings: Recording[] }[]
    tools: {
        dtk: boolean
        ffmpeg: boolean
        rerun: boolean
        foxglove: boolean
        apps: string[]
    }
    thumbnails: { working: string | null }
}

export type SortKey = "date" | "size" | "duration" | "name"
export type Order = "asc" | "desc"

export type Job = {
    id: string
    recording: string
    from: string
    to: "db" | "mcap" | "rrd"
    state: "running" | "done" | "failed" | "cancelled"
    progress: number | null
    phase: string
    result: string | null
    error: string | null
}

export type Upload = {
    id: string
    path: string
    name: string
    size: number
    state: "queued" | "uploading" | "done" | "failed" | "cancelled"
    phase: "preparing" | "compress" | "hash" | "upload" | "finishing" | null
    bytesDone: number
    bytesTotal: number
    rateBps: number | null
    etaSeconds: number | null
    error: string | null
    errorCode: string | null
    notice: string | null
    link: string | null
}

export type Tray = {
    uploads: Upload[]
    waitingForLogin: boolean
    account: { loggedIn: boolean; email?: string | null; error?: string | null }
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

export const api = {
    list: (sort: SortKey, order: Order) =>
        call<ListResponse>(
            "GET",
            `api/recordings?sort=${sort}&order=${order}&tz=${new Date().getTimezoneOffset()}`,
        ),
    get: (id: string) =>
        call<Recording & { inspection: Inspection | null }>(
            "GET",
            `api/recordings/${enc(id)}`,
        ),
    thumbnailUrl: (id: string, version: number) => `api/recordings/${enc(id)}/thumbnail?v=${version}`,
    setNote: (id: string, text: string) => call("PUT", `api/recordings/${enc(id)}/note`, { text }),
    rename: (id: string, name: string) => call<{ id: string }>("POST", `api/recordings/${enc(id)}/rename`, { name }),
    remove: (id: string) => call("DELETE", `api/recordings/${enc(id)}`),
    duplicate: (id: string) => call<{ id: string }>("POST", `api/recordings/${enc(id)}/duplicate`, {}),
    convert: (id: string, to: string) => call<Job>("POST", `api/recordings/${enc(id)}/convert`, { to }),
    jobs: () => call<{ jobs: Job[] }>("GET", "api/jobs"),
    cancelJob: (id: string) => call("DELETE", `api/jobs/${enc(id)}`),
    open: (id: string, target: string, show = true) =>
        call<{ opened: string; app?: string }>(
            "POST",
            `api/recordings/${enc(id)}/open`,
            {
                target,
                show,
            },
        ),
    reveal: (id: string) => call("POST", `api/recordings/${enc(id)}/reveal`, {}),
    upload: (id: string) => call<Upload>("POST", `api/recordings/${enc(id)}/upload`, {}),
    tray: () => call<Tray>("GET", "api/uploads"),
    removeUpload: (id: string) => call("DELETE", `api/uploads/${enc(id)}`),
    retryUpload: (id: string) => call("POST", `api/uploads/${enc(id)}/retry`, {}),
}

/** Desktop's own pages, from /apps/<name>/ */
export const desktopPath = (path: string) => new URL(`../../${path.replace(/^\/+/, "")}`, location.href).href

// ── formatting ──
export function bytes(n: number): string {
    if (n < 1024) {
        return `${n} B`
    }
    const units = ["KB", "MB", "GB", "TB"]
    let value = n / 1024
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit++
    }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export function duration(seconds: number | null): string {
    if (seconds === null || !(seconds >= 0)) {
        return "—"
    }
    if (seconds < 60) {
        return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`
    }
    const whole = Math.round(seconds)
    const h = Math.floor(whole / 3600)
    const m = Math.floor(whole / 60) % 60
    const s = whole % 60
    return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(s).padStart(2, "0")}s`
}

export function when(seconds: number, section: string | null): string {
    const date = new Date(seconds * 1000)
    const time = date.toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
    })
    if (section === "Today" || section === "Yesterday") {
        return time
    }
    const sameYear = date.getFullYear() === new Date().getFullYear()
    const day = date.toLocaleDateString([], {
        weekday: section === "This week" || section === "Last week" ? "short" : undefined,
        month: "short",
        day: "numeric",
        year: sameYear ? undefined : "numeric",
    })
    return `${day}, ${time}`
}

export function gap(seconds: number): string {
    if (!(seconds > 0)) {
        return "—"
    }
    return seconds < 1 ? `${Math.round(seconds * 1000)} ms` : `${seconds.toFixed(2)} s`
}

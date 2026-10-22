// Uploads to the Dimensional cloud go through Desktop's dimos server (`/gateways/dimos/cloud/uploads`,
// `/gateways/dimos/cloud/account`; the gateway's API 4.0, the same in 5.x). This only relays, so the page and the agent
// use one set of endpoints.
import type { Config } from "../config.ts"
import { HttpError, stateChanged } from "../http.ts"
import { basename } from "node:path"
import { CloudPreviews } from "./cloud_preview.ts"
import {
    baselineFits,
    type Baselines,
    type GatewayEntry,
    judge,
    type Judgement,
    type TopicSummary,
    versionedName,
} from "./reupload.ts"

export type Uploaded = GatewayEntry

/** a recording's latest upload and whether it changed since (`changed` is by topic summary when one was kept) */
export type UploadStatus = GatewayEntry & Judgement & {
    /** the name it went up as: the file's, or a re-upload's name.vN.ext */
    name: string
    /** the gateway's own check: the file's size or mtime moved since (a byte edit the summary can't see) */
    bytesChanged: boolean
    /** what a re-upload would be called */
    nextName: string
}

export class Uploads {
    /** TEMPORARY: the console preview for finished .mcap uploads, which dimos's gateway doesn't send yet */
    previews: CloudPreviews

    constructor(public config: Config, public baselines: Baselines) {
        this.previews = new CloudPreviews(config)
    }

    async #call(method: string, path: string, body?: unknown) {
        if (!this.config.desktopUrl) {
            throw new HttpError(503, "Uploads go through dimOS Desktop: open the Recordings app from Desktop to upload")
        }
        let response: Response
        try {
            response = await fetch(`${this.config.desktopUrl}${path}`, {
                method,
                headers: body === undefined ? {} : { "content-type": "application/json" },
                body: body === undefined ? undefined : JSON.stringify(body),
            })
        } catch (error) {
            throw new HttpError(502, `Desktop didn't answer: ${error instanceof Error ? error.message : error}`)
        }
        const text = await response.text()
        if (!response.ok) {
            let message = text
            try {
                message = JSON.parse(text).error ?? text
            } catch {
                // plain text
            }
            throw new HttpError(response.status, message.slice(0, 400))
        }
        if (method !== "GET") {
            stateChanged("uploads") // the tray (progress arrives as the dimos server's upload events)
        }
        return text ? JSON.parse(text) : null
    }

    /** path → its last upload (GET cloud/uploads's byPath, kept across restarts); {} when Desktop can't say */
    async uploadedByPath(): Promise<Record<string, Uploaded>> {
        if (!this.config.desktopUrl) {
            return {}
        }
        try {
            const byPath = (await this.#call("GET", "/gateways/dimos/cloud/uploads"))?.byPath ?? {}
            this.previews.consider(Object.values(byPath))
            return byPath
        } catch {
            return {}
        }
    }

    /** queues `path`, keeping the recording's topic summary as it is now for later change checks */
    start(path: string, recording: { path: string; size: number; modified: number }, summary: TopicSummary | null) {
        if (summary) {
            this.baselines.set(path, {
                recording: recording.path,
                summary,
                size: recording.size,
                mtimeMs: Math.floor(recording.modified * 1000),
                at: Date.now(),
            })
        }
        return this.#call("POST", "/gateways/dimos/cloud/uploads", { path })
    }

    /** the recording's latest upload (itself or a vN), judged against its summary now; null when never uploaded */
    status(
        recording: { path: string; name: string },
        current: TopicSummary | null,
        byPath: Record<string, Uploaded>,
        localNames: string[],
    ): UploadStatus | null {
        const entries = this.baselines.pathsOf(recording.path).map((path) => byPath[path]).filter(Boolean)
        if (!entries.length) {
            return null
        }
        const latest = entries.reduce((a, b) => b.uploadedAt > a.uploadedAt ? b : a)
        if (current && !latest.changed && !baselineFits(this.baselines.all()[latest.path], latest)) {
            // an upload from before summaries were kept, whose file hasn't changed since: its summary is today's
            this.baselines.set(latest.path, {
                recording: recording.path,
                summary: current,
                size: latest.size ?? 0,
                mtimeMs: latest.mtimeMs ?? 0,
                at: Date.now(),
                backfilled: true,
            })
        }
        const taken = [...Object.keys(byPath).map((path) => basename(path)), ...localNames]
        return {
            ...latest,
            ...judge(latest, this.baselines.all()[latest.path], current),
            name: basename(latest.path),
            bytesChanged: latest.changed,
            nextName: versionedName(recording.name, taken),
        }
    }

    /** the queued or running upload of this recording (itself or a vN), if any */
    async live(recording: string): Promise<{ id: string; path: string; state: string } | undefined> {
        const paths = new Set(this.baselines.pathsOf(recording))
        const queue = await this.#call("GET", "/gateways/dimos/cloud/uploads")
        const uploads = (queue?.uploads ?? []) as { id: string; path: string; state: string }[]
        return uploads.find((u) => paths.has(u.path) && (u.state === "queued" || u.state === "uploading"))
    }

    async tray() {
        const [queue, account] = await Promise.all([
            this.#call("GET", "/gateways/dimos/cloud/uploads"),
            this.#call("GET", "/gateways/dimos/cloud/account").catch((error) => ({
                loggedIn: false,
                error: error.message,
            })),
        ])
        try {
            this.previews.consider(Object.values(queue?.byPath ?? {}), account?.cloudUrl)
        } catch {
            // the preview is extra
        }
        // a vN re-upload's path is its symlink: name the recording it is, so the page finds it by the recording's path
        const all = this.baselines.all()
        const uploads = ((queue?.uploads ?? []) as { path: string }[]).map((u) => ({
            ...u,
            recording: all[u.path]?.recording ?? u.path,
        }))
        return { ...queue, uploads, account }
    }

    remove(id: string) {
        return this.#call("DELETE", `/gateways/dimos/cloud/uploads?id=${encodeURIComponent(id)}`)
    }

    retry(id: string) {
        return this.#call("POST", "/gateways/dimos/cloud/uploads", { retry: id })
    }
}

// Uploads to the Dimensional cloud go through Desktop's dimos server (`/dimos-gateway/cloud/uploads`,
// `/dimos-gateway/cloud/account`; the gateway's API 4.0). This only relays, so the page and the agent use one set of
// endpoints.
import type { Config } from "../config.ts"
import { HttpError, stateChanged } from "../http.ts"
import { CloudPreviews } from "./cloud_preview.ts"

export type Uploaded = { path: string; uploadId: string; link: string | null; changed: boolean; uploadedAt: number }

export class Uploads {
    /** TEMPORARY: the console preview for finished .mcap uploads, which dimos's gateway doesn't send yet */
    previews: CloudPreviews

    constructor(public config: Config) {
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
            const byPath = (await this.#call("GET", "/dimos-gateway/cloud/uploads"))?.byPath ?? {}
            this.previews.consider(Object.values(byPath))
            return byPath
        } catch {
            return {}
        }
    }

    start(path: string) {
        return this.#call("POST", "/dimos-gateway/cloud/uploads", { path })
    }

    async tray() {
        const [queue, account] = await Promise.all([
            this.#call("GET", "/dimos-gateway/cloud/uploads"),
            this.#call("GET", "/dimos-gateway/cloud/account").catch((error) => ({
                loggedIn: false,
                error: error.message,
            })),
        ])
        try {
            this.previews.consider(Object.values(queue?.byPath ?? {}), account?.cloudUrl)
        } catch {
            // the preview is extra
        }
        return { ...queue, account }
    }

    remove(id: string) {
        return this.#call("DELETE", `/dimos-gateway/cloud/uploads?id=${encodeURIComponent(id)}`)
    }

    retry(id: string) {
        return this.#call("POST", "/dimos-gateway/cloud/uploads", { retry: id })
    }
}

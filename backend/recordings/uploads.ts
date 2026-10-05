// Uploads to the Dimensional cloud go through Desktop's dimos server (`/dimos/uploads`, `/dimos/cloud/*`; the
// contract: NosyPuma upload_api.md). This only relays, so the page and the agent use one set of endpoints.
import type { Config } from "../config.ts"
import { HttpError, stateChanged } from "../http.ts"

export type Uploaded = { path: string; uploadId: string; link: string | null; changed: boolean; uploadedAt: number }

export class Uploads {
    constructor(public config: Config) {}

    async #call(method: string, path: string, body?: unknown) {
        if (!this.config.desktopUrl) {
            throw new HttpError(503, "uploads go through Desktop, and this app isn't running in one")
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

    /** path → its last upload (Desktop keeps this across restarts); {} when Desktop doesn't have the endpoint yet */
    async uploadedByPath(): Promise<Record<string, Uploaded>> {
        if (!this.config.desktopUrl) {
            return {}
        }
        try {
            return (await this.#call("GET", "/dimos/uploads/uploaded"))?.byPath ?? {}
        } catch {
            return {}
        }
    }

    start(path: string) {
        return this.#call("POST", "/dimos/uploads", { path })
    }

    async tray() {
        const [queue, account] = await Promise.all([
            this.#call("GET", "/dimos/uploads"),
            this.#call("GET", "/dimos/cloud/account").catch((error) => ({ loggedIn: false, error: error.message })),
        ])
        return { ...queue, account }
    }

    remove(id: string) {
        return this.#call("DELETE", `/dimos/uploads/${encodeURIComponent(id)}`)
    }

    retry(id: string) {
        return this.#call("POST", `/dimos/uploads/${encodeURIComponent(id)}/retry`)
    }

    login() {
        return this.#call("POST", "/dimos/cloud/login")
    }
}

// The background job behind the preview clips: one recording at a time, with pauses (thumbnails.ts), each result
// kept under the app data dir by the file's identity (format + size + mtime, so a rename keeps it).
import { join } from "node:path"
import { Library } from "./library.ts"
import type { FileEntry } from "./scan.ts"
import { buildThumbnail, ffmpeg, PAUSE_BETWEEN_RECORDINGS_MS, type ThumbMeta } from "./thumbnails.ts"

export type ThumbState =
    | { state: "ready"; frames: number; width: number; height: number; stream: string }
    | { state: "none"; reason: string }
    | { state: "pending" }

export class Thumbnailer {
    running = false
    current: string | null = null
    log: {
        id: string
        at: number
        stream: string | null
        wallSeconds: number
        appCpuSeconds: number
        error?: string
    }[] = []
    #wake: (() => void) | null = null

    constructor(public library: Library) {}

    async folder(file: Pick<FileEntry, "format" | "size" | "modified">) {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(Library.key(file)))
        const hex = [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("")
        return join(this.library.config.dataDir, "thumbs", hex)
    }

    async stateOf(file: FileEntry): Promise<ThumbState> {
        if (file.format === "rrd") {
            return { state: "none", reason: ".rrd files have no preview" }
        }
        const folder = await this.folder(file)
        try {
            const meta = JSON.parse(await Deno.readTextFile(join(folder, "meta.json"))) as ThumbMeta
            return { state: "ready", frames: meta.frames, width: meta.width, height: meta.height, stream: meta.stream }
        } catch {
            try {
                const none = JSON.parse(await Deno.readTextFile(`${folder}.none.json`)) as { reason: string }
                return { state: "none", reason: none.reason }
            } catch {
                return { state: "pending" }
            }
        }
    }

    async sprite(file: FileEntry): Promise<Uint8Array> {
        return await Deno.readFile(join(await this.folder(file), "sprite.jpg"))
    }

    /** Look for work now (after a new file, a rename, a conversion). */
    poke() {
        this.#wake?.()
    }

    start() {
        if (this.running) {
            return
        }
        this.running = true
        Deno.mkdirSync(join(this.library.config.dataDir, "thumbs"), { recursive: true })
        this.#loop()
    }

    async #loop() {
        while (this.running) {
            let did = false
            try {
                did = await this.#one()
            } catch (error) {
                console.error("thumbnails:", error)
            }
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, did ? PAUSE_BETWEEN_RECORDINGS_MS : 30_000)
                this.#wake = () => {
                    clearTimeout(timer)
                    resolve()
                }
            })
            this.#wake = null
        }
    }

    /** Builds the next missing preview; false when there's nothing to do. */
    async #one(): Promise<boolean> {
        if (!ffmpeg()) {
            return false
        }
        const files = (await this.library.files()).filter((file) => file.format !== "rrd")
        // newest first: what the user just recorded is what they look for
        files.sort((a, b) => b.modified - a.modified)
        for (const file of files) {
            if ((await this.stateOf(file)).state !== "pending") {
                continue
            }
            const folder = await this.folder(file)
            this.current = file.id
            const started = performance.now()
            try {
                const inspection = await this.library.inspection(file)
                const meta = await buildThumbnail(file.path, file.format as "db" | "mcap", inspection, folder)
                if (!meta) {
                    await Deno.writeTextFile(`${folder}.none.json`, JSON.stringify({ reason: "no camera stream" }))
                }
                this.#record(file.id, meta, (performance.now() - started) / 1000)
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                await Deno.writeTextFile(
                    `${folder}.none.json`,
                    JSON.stringify({ reason: `preview failed: ${message}` }),
                )
                this.#record(file.id, null, (performance.now() - started) / 1000, message)
            } finally {
                this.current = null
            }
            this.library.emit({ type: "thumbnail", id: file.id })
            return true
        }
        return false
    }

    #record(id: string, meta: ThumbMeta | null, wallSeconds: number, error?: string) {
        const entry = {
            id,
            at: Date.now() / 1000,
            stream: meta?.stream ?? null,
            wallSeconds,
            appCpuSeconds: meta?.stats.appCpuSeconds ?? 0,
            ...(error ? { error } : {}),
        }
        this.log = [entry, ...this.log].slice(0, 50)
        console.error(
            `thumbnails: ${id} ${meta ? `${meta.frames} frames of ${meta.stream}` : error ?? "no camera"} in ${
                wallSeconds.toFixed(1)
            } s (app cpu ${entry.appCpuSeconds.toFixed(2)} s)`,
        )
    }
}

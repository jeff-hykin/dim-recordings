// The background job behind the preview clips: one recording at a time, with pauses (thumbnails.ts), each result
// kept under the app data dir by the file's identity (format + size + mtime, so a rename keeps it).
import { join } from "node:path"
import { Library } from "./library.ts"
import { type PathPreview, pathPreview } from "./path_preview.ts"
import type { FileEntry } from "./scan.ts"
import { buildThumbnail, ffmpeg, PAUSE_BETWEEN_RECORDINGS_MS, type ThumbMeta } from "./thumbnails.ts"

/** What a recording with no camera was marked before odometry paths: it's looked at again once. */
const OLD_NO_CAMERA = "no camera stream"

export type ThumbState =
    | { state: "ready"; frames: number; width: number; height: number; stream: string }
    | ({ state: "path" } & PathPreview)
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
    /** a poke that came while a pass was running: look again straight away */
    #poked = false

    /** files outside the recordings folder that want a preview too (a plugged-in drive's), done first */
    extra: () => FileEntry[] = () => []

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
                const path = JSON.parse(await Deno.readTextFile(`${folder}.path.json`)) as PathPreview
                return { state: "path", ...path }
            } catch {
                // no path either
            }
            try {
                const none = JSON.parse(await Deno.readTextFile(`${folder}.none.json`)) as { reason: string }
                return none.reason === OLD_NO_CAMERA ? { state: "pending" } : { state: "none", reason: none.reason }
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
        this.#poked = true
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
            this.#poked = false
            try {
                did = await this.#one()
            } catch (error) {
                console.error("thumbnails:", error)
            }
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, did || this.#poked ? PAUSE_BETWEEN_RECORDINGS_MS : 30_000)
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
        const library = (await this.library.files()).filter((file) => file.format !== "rrd")
        // newest first: what the user just recorded is what they look for
        library.sort((a, b) => b.modified - a.modified)
        for (const file of [...this.extra(), ...library]) {
            if ((await this.stateOf(file)).state !== "pending") {
                continue
            }
            const folder = await this.folder(file)
            this.current = file.id
            const started = performance.now()
            try {
                const inspection = await this.library.inspection(file)
                const cameras = inspection.streams.some((s) => /(^|\.)(Image|CompressedImage)$/.test(s.type) && s.count)
                if (cameras && !ffmpeg()) {
                    continue // stays pending until there's an ffmpeg
                }
                const meta = cameras
                    ? await buildThumbnail(file.path, file.format as "db" | "mcap", inspection, folder)
                    : null
                // no camera: the odometry path from above, when it has one
                const path = meta ? null : await pathPreview(file.path)
                if (path) {
                    await Deno.writeTextFile(`${folder}.path.json`, JSON.stringify(path))
                } else if (!meta) {
                    await Deno.writeTextFile(
                        `${folder}.none.json`,
                        JSON.stringify({
                            reason: cameras ? "no readable camera frames" : "no camera, and it didn't move",
                        }),
                    )
                }
                this.#record(file.id, meta, (performance.now() - started) / 1000, undefined, path?.stream)
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

    #record(id: string, meta: ThumbMeta | null, wallSeconds: number, error?: string, pathStream?: string) {
        const entry = {
            id,
            at: Date.now() / 1000,
            stream: meta?.stream ?? pathStream ?? null,
            wallSeconds,
            appCpuSeconds: meta?.stats.appCpuSeconds ?? 0,
            ...(error ? { error } : {}),
        }
        this.log = [entry, ...this.log].slice(0, 50)
        console.error(
            `thumbnails: ${id} ${
                meta
                    ? `${meta.frames} frames of ${meta.stream}`
                    : pathStream
                    ? `path from ${pathStream}`
                    : error ?? "no camera"
            } in ${wallSeconds.toFixed(1)} s (app cpu ${entry.appCpuSeconds.toFixed(2)} s)`,
        )
    }
}

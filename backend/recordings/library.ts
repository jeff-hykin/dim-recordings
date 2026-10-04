// The app's view of the recordings folder: the file list joined with each file's inspection (cached in memory and on
// disk under the app data dir, keyed by format + size + mtime), notes, thumbnails and what can open it.
import { join } from "node:path"
import type { Config } from "../config.ts"
import { inspect, type Inspection } from "./inspect.ts"
import { type FileEntry, type Listed, pairRrds, resolveId, scanFiles } from "./scan.ts"

export type Recording = Listed & {
    /** when it was recorded: its first message's time when the file has one, else the file's mtime */
    recorded: number
    recordedFrom: "messages" | "mtime"
    duration: number | null
    summary: string | null
    /** null while the file hasn't been read yet (a background job reads it, then a `recordings` event fires) */
    inspection: Inspection | null
    note: string
}

type Listener = (event: Record<string, unknown>) => void

export class Library {
    #inspections = new Map<string, Inspection>()
    #pending = new Set<string>()
    #queue: Promise<void> = Promise.resolve()
    #notes: Record<string, string> | null = null
    listeners = new Set<Listener>()

    constructor(public config: Config) {
        Deno.mkdirSync(join(config.dataDir, "inspections"), { recursive: true })
    }

    emit(event: Record<string, unknown>) {
        for (const listener of this.listeners) {
            listener(event)
        }
    }

    get dir() {
        return this.config.recordingsDir
    }

    path(id: string) {
        return resolveId(this.dir, id)
    }

    /** content identity without reading it: a rename keeps it, so a renamed (or cloned) file keeps its cache */
    static key(file: Pick<FileEntry, "format" | "size" | "modified">) {
        return `${file.format}|${file.size}|${file.modified}`
    }

    async #diskPath(key: string) {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))
        const hex = [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("")
        return join(this.config.dataDir, "inspections", `${hex}.json`)
    }

    /** The cached inspection, or null (and one is queued). */
    async cached(file: FileEntry): Promise<Inspection | null> {
        const key = Library.key(file)
        const known = this.#inspections.get(key)
        if (known) {
            return known
        }
        try {
            const saved = JSON.parse(await Deno.readTextFile(await this.#diskPath(key))) as Inspection
            this.#inspections.set(key, saved)
            return saved
        } catch {
            this.#enqueue(file)
            return null
        }
    }

    /** Reads it now (or waits for the queued read). */
    async inspection(file: FileEntry): Promise<Inspection> {
        const cached = await this.cached(file)
        if (cached) {
            return cached
        }
        await this.#queue
        return this.#inspections.get(Library.key(file)) ?? await this.#read(file)
    }

    #enqueue(file: FileEntry) {
        const key = Library.key(file)
        if (this.#pending.has(key)) {
            return
        }
        this.#pending.add(key)
        this.#queue = this.#queue.then(async () => {
            try {
                await this.#read(file)
                this.emit({ type: "recordings", reason: "inspected", id: file.id })
            } finally {
                this.#pending.delete(key)
            }
        })
    }

    async #read(file: FileEntry): Promise<Inspection> {
        const key = Library.key(file)
        let result: Inspection
        try {
            result = await inspect(file.path)
        } catch (error) {
            result = {
                format: file.format === "mcap" ? "mcap" : "db",
                start: null,
                end: null,
                duration: null,
                messages: 0,
                streams: [],
                tf: { source: null, seconds: 0, messages: 0, edges: [], roots: [], conflicts: [] },
                summary: "unreadable",
                error: error instanceof Error ? error.message : String(error),
            }
        }
        this.#inspections.set(key, result)
        await Deno.writeTextFile(await this.#diskPath(key), JSON.stringify(result))
        return result
    }

    // ── notes: one JSON file in the app data dir, keyed by recording id ──
    #notesFile() {
        return join(this.config.dataDir, "notes.json")
    }
    notes(): Record<string, string> {
        if (!this.#notes) {
            try {
                this.#notes = JSON.parse(Deno.readTextFileSync(this.#notesFile()))
            } catch {
                this.#notes = {}
            }
        }
        return this.#notes!
    }
    setNote(id: string, text: string) {
        const notes = this.notes()
        if (text.trim()) {
            notes[id] = text
        } else {
            delete notes[id]
        }
        const temporary = `${this.#notesFile()}.partial`
        Deno.writeTextFileSync(temporary, JSON.stringify(notes, null, 4))
        Deno.renameSync(temporary, this.#notesFile())
    }
    moveNote(from: string, to: string) {
        const text = this.notes()[from]
        if (text !== undefined) {
            this.setNote(to, text)
            this.setNote(from, "")
        }
    }

    // ── the list ──
    async files(): Promise<FileEntry[]> {
        return await scanFiles(this.dir)
    }

    async list(): Promise<Recording[]> {
        const listed = pairRrds(await this.files())
        const notes = this.notes()
        const out: Recording[] = []
        for (const item of listed) {
            const inspection = item.format === "rrd" ? null : await this.cached(item)
            out.push(this.#describe(item, inspection, notes[item.id] ?? ""))
        }
        return out
    }

    #describe(item: Listed, inspection: Inspection | null, note: string): Recording {
        const start = inspection?.start ?? null
        // a recording's own clock when it looks like wall time (after 2000, not in the future), else the file's mtime
        const plausible = start !== null && start > 946684800 && start < Date.now() / 1000 + 86400
        return {
            ...item,
            recorded: plausible ? start! : item.modified,
            recordedFrom: plausible ? "messages" : "mtime",
            duration: inspection?.duration ?? null,
            summary: inspection?.summary ?? null,
            inspection,
            note,
        }
    }

    async get(id: string): Promise<Recording> {
        const all = await this.list()
        const found = all.find((item) => item.id === id) ??
            all.flatMap((item) => item.rrds.map((rrd) => ({ ...rrd, rrds: [], standalone: false }))).find((rrd) =>
                rrd.id === id
            )
        if (!found) {
            throw new NotFound(`no such recording: ${id}`)
        }
        if (found.format !== "rrd" && !("inspection" in found && found.inspection)) {
            return this.#describe(found, await this.inspection(found), this.notes()[id] ?? "")
        }
        return "recorded" in found ? found as Recording : this.#describe(found, null, this.notes()[id] ?? "")
    }
}

export class NotFound extends Error {}

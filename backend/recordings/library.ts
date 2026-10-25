// The app's view of the recordings folder: the file list joined with each file's inspection (cached in memory and on
// disk under the app data dir, keyed by format + size + mtime), notes, thumbnails and what can open it.
import { isAbsolute, join, relative } from "node:path"
import type { Config } from "../config.ts"
import { inChild, JobCancelled, laneFor } from "./child_jobs.ts"
import type { Inspection } from "./inspect.ts"
import { type FileEntry, type Listed, pairRrds, resolveId, scanFiles } from "./scan.ts"
import { fs } from "./slow_fs.ts"

const INSPECTION_VERSION = 2

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

/** An extra folder the page added (kept in its localStorage only), and what scanning it found. */
export type ExtraDir = {
    /** as the page gave it */
    dir: string
    /** with ~ expanded */
    path: string
    /** what its recordings' ids start with */
    prefix: string
    /** .db/.mcap recordings found in it; null when it couldn't be read */
    count: number | null
    error: string | null
}

export function expandHome(dir: string): string {
    const home = Deno.env.get("HOME") ?? ""
    return dir === "~" ? home : dir.startsWith("~/") ? join(home, dir.slice(2)) : dir
}

/** The page's list of extra folders (an array, or one as JSON in a query param): trimmed, non-empty, no repeats. */
export function cleanDirs(value: unknown): string[] {
    let list = value
    if (typeof value === "string") {
        try {
            list = JSON.parse(value)
        } catch {
            list = [value]
        }
    }
    if (!Array.isArray(list)) {
        return []
    }
    const dirs = list.filter((dir) => typeof dir === "string").map((dir) => dir.trim().replace(/(.)\/+$/, "$1"))
    return [...new Set(dirs.filter(Boolean))].slice(0, 64)
}

/** ".extra/<hash of its path>/": the scan skips dot-names, so no shared-folder id starts with it */
async function prefixOf(path: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path))
    return `.extra/${[...new Uint8Array(digest)].slice(0, 5).map((b) => b.toString(16).padStart(2, "0")).join("")}/`
}

async function realOf(path: string): Promise<string> {
    try {
        return await fs.realPath(path)
    } catch {
        return path
    }
}

export class Library {
    #inspections = new Map<string, Inspection>()
    /** inspections queued or running (child_jobs.ts runs them one at a time per cost lane), by key */
    #pending = new Map<string, Promise<Inspection>>()
    #notes: Record<string, string> | null = null
    listeners = new Set<Listener>()
    /** the extra folders the page sent last (with its list; in memory only: the page's localStorage is the record) */
    extraDirs: string[] = []
    /** told the expanded paths whenever extraDirs changes (main.ts watches them) */
    onExtraDirs: (paths: string[]) => void = () => {}

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

    setExtraDirs(dirs: string[]) {
        if (JSON.stringify(dirs) === JSON.stringify(this.extraDirs)) {
            return
        }
        this.extraDirs = dirs
        this.onExtraDirs(dirs.map(expandHome).filter((path) => isAbsolute(path)))
    }

    /** The id a file at `path` has (after a rename or duplicate), in the shared folder or one of the extra ones. */
    async idOf(path: string): Promise<string> {
        if (path.startsWith(`${this.dir}/`)) {
            return path.slice(this.dir.length + 1)
        }
        for (const dir of this.extraDirs.map(expandHome)) {
            for (const root of new Set([dir, await realOf(dir)])) {
                if (path.startsWith(`${root}/`)) {
                    return (await prefixOf(dir)) + relative(root, path)
                }
            }
        }
        return path.slice(this.dir.length + 1)
    }

    /** content identity without reading it: a rename keeps it, so a renamed (or cloned) file keeps its cache */
    static key(file: Pick<FileEntry, "format" | "size" | "modified">) {
        return `${file.format}|${file.size}|${file.modified}`
    }

    async #diskPath(key: string) {
        // the inspection's shape is in the name, so a new one (warnings, tf edge spans) re-reads each file once
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${INSPECTION_VERSION}|${key}`))
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

    /** Waits for its inspection (queued if it wasn't). */
    async inspection(file: FileEntry): Promise<Inspection> {
        return await this.cached(file) ?? await this.#enqueue(file)
    }

    /** Settles once no inspection is queued or running (tests; a shutdown). */
    async idle() {
        while (this.#pending.size) {
            await Promise.allSettled([...this.#pending.values()])
        }
    }

    #enqueue(file: FileEntry): Promise<Inspection> {
        const key = Library.key(file)
        let pending = this.#pending.get(key)
        if (!pending) {
            pending = this.#read(file).finally(() => this.#pending.delete(key))
            this.#pending.set(key, pending)
            pending.then(() => this.emit({ type: "recordings", reason: "inspected", id: file.id }), () => {})
        }
        return pending
    }

    async #read(file: FileEntry): Promise<Inspection> {
        const key = Library.key(file)
        let result: Inspection
        try {
            // in a child process: a big file's read never holds the server's thread, and its memory dies with it
            result = await inChild("inspect", [file.path], { lane: laneFor(file.size), path: file.path })
        } catch (error) {
            if (error instanceof JobCancelled) {
                throw error // the file went away: nothing to keep
            }
            result = {
                format: file.format === "mcap" ? "mcap" : "db",
                start: null,
                end: null,
                duration: null,
                messages: 0,
                streams: [],
                tf: { source: null, coverage: "", messages: 0, edges: [], roots: [], conflicts: [] },
                warnings: [],
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
    /** The shared folder's files, then each extra folder's (a file already listed through another folder isn't
     * repeated), and what each extra folder held or why it couldn't be read. Ids only ever resolve to these files. */
    async scan(extraDirs = this.extraDirs): Promise<{ files: FileEntry[]; extraDirs: ExtraDir[] }> {
        const files = await scanFiles(this.dir)
        const sharedReal = await realOf(this.dir)
        const seen = new Set(files.map((file) => join(sharedReal, file.id)))
        const statuses: ExtraDir[] = []
        for (const dir of extraDirs) {
            const path = expandHome(dir)
            const status: ExtraDir = { dir, path, prefix: await prefixOf(path), count: null, error: null }
            statuses.push(status)
            try {
                if (!isAbsolute(path)) {
                    throw new Error("not a full path (start it with / or ~)")
                }
                const stat = await fs.stat(path)
                if (!stat.isDirectory) {
                    throw new Error("not a folder")
                }
                await fs.readDir(path) // unreadable (permissions) says so here; the scan below skips quietly
                const real = await realOf(path)
                const found = (await scanFiles(path, status.prefix)).filter((file) => {
                    const key = join(real, file.id.slice(status.prefix.length))
                    if (seen.has(key)) {
                        return false
                    }
                    seen.add(key)
                    return true
                })
                status.count = found.filter((file) => file.format !== "rrd").length
                files.push(...found.map((file) => ({ ...file, root: dir })))
            } catch (error) {
                status.error = error instanceof Error && error.name === "NotFound"
                    ? "no such folder"
                    : error instanceof Error
                    ? error.message
                    : String(error)
            }
        }
        return { files, extraDirs: statuses }
    }

    async files(extraDirs = this.extraDirs): Promise<FileEntry[]> {
        return (await this.scan(extraDirs)).files
    }

    async list(extraDirs = this.extraDirs): Promise<Recording[]> {
        return this.describeAll(await this.files(extraDirs))
    }

    async describeAll(files: FileEntry[]): Promise<Recording[]> {
        const listed = pairRrds(files)
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
        // a small file not read yet is read now (its own lane, a moment); a big one answers without it, and the
        // `recordings` event when it's read brings it
        if (found.format !== "rrd" && !("inspection" in found && found.inspection) && laneFor(found.size) === "small") {
            return this.#describe(found, await this.inspection(found), this.notes()[id] ?? "")
        }
        return "recorded" in found ? found as Recording : this.#describe(found, null, this.notes()[id] ?? "")
    }
}

export class NotFound extends Error {}

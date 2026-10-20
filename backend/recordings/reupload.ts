// Re-uploads: each upload keeps the recording's topic summary from when it went up, so the app can tell when the
// recording changed since; a changed one goes up again as name.v2.mcap (v3, ...) through a symlink by that name, since
// the cloud names an upload after the file it reads, and the earlier upload stays as it was.
import { basename, dirname, join } from "node:path"
import type { Inspection } from "./inspect.ts"

/** per stream (sorted by name): what an edit moves (rename, delete, trim, append, retype); times in ms */
export type TopicSummary = { name: string; type: string; count: number; start: number | null; end: number | null }[]

export function topicSummary(inspection: Pick<Inspection, "streams">): TopicSummary {
    const ms = (time: number | null) => time === null ? null : Math.round(time * 1000)
    const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
    return inspection.streams
        .map((s) => ({ name: s.name, type: s.type, count: s.count, start: ms(s.start), end: ms(s.end) }))
        .sort((a, b) => order(a.name, b.name) || order(a.type, b.type))
}

/** what differs, one line per stream ("odom: 1200 → 900 messages"); empty when the summaries match */
export function summaryChanges(before: TopicSummary, after: TopicSummary): string[] {
    const was = new Map(before.map((s) => [s.name, s]))
    const now = new Map(after.map((s) => [s.name, s]))
    const changes: string[] = []
    for (const [name, old] of was) {
        const fresh = now.get(name)
        if (!fresh) {
            changes.push(`${name}: removed`)
        } else if (fresh.type !== old.type) {
            changes.push(`${name}: ${old.type} → ${fresh.type}`)
        } else if (fresh.count !== old.count) {
            changes.push(`${name}: ${old.count} → ${fresh.count} messages`)
        } else if (fresh.start !== old.start || fresh.end !== old.end) {
            changes.push(`${name}: its first or last message moved`)
        }
    }
    for (const name of now.keys()) {
        if (!was.has(name)) {
            changes.push(`${name}: added`)
        }
    }
    return changes
}

/** foo.v2.mcap → { base: "foo", version: 2, ext: ".mcap" }; an unversioned name is version 1 */
export function splitVersion(name: string): { base: string; version: number; ext: string } {
    const match = name.match(/^(.+?)(?:\.v(\d+))?(\.[A-Za-z0-9]+)$/)
    if (!match) {
        return { base: name, version: 1, ext: "" }
    }
    return { base: match[1], version: match[2] === undefined ? 1 : Number(match[2]), ext: match[3] }
}

/** the next version after the name's own and every taken one of the same base: foo.mcap → foo.v2.mcap, a v2 → v3 */
export function versionedName(name: string, taken: Iterable<string>): string {
    const own = splitVersion(name)
    let highest = Math.max(own.version, 1)
    for (const other of taken) {
        const it = splitVersion(other)
        if (it.base === own.base && it.ext === own.ext) {
            highest = Math.max(highest, it.version)
        }
    }
    return `${own.base}.v${highest + 1}${own.ext}`
}

/** the topic summary an upload went up with, and the file's size and mtime then (to tell if it's still that file) */
export type Baseline = {
    /** the recording it's of: the uploaded path itself, or what a vN symlink points at */
    recording: string
    summary: TopicSummary
    size: number
    mtimeMs: number
    at: number
    /** taken after the fact from an older upload whose file hadn't changed since */
    backfilled?: boolean
}

/** what the dimos gateway's byPath says about one uploaded path (size and mtime as it found them when done) */
export type GatewayEntry = {
    path: string
    uploadId: string
    link: string | null
    changed: boolean
    uploadedAt: number
    size?: number
    mtimeMs?: number
}

export type Judgement = {
    changed: boolean
    /** "summary": the topic summaries were compared; "size+mtime": no summary from upload time, so the gateway's check */
    changedBy: "summary" | "size+mtime"
    changes: string[]
}

/** whether the baseline is of the file the gateway saw finish (an upload retried after an edit isn't) */
export function baselineFits(baseline: Baseline | undefined, entry: GatewayEntry): baseline is Baseline {
    if (!baseline) {
        return false
    }
    if (entry.size === undefined || entry.mtimeMs === undefined) {
        return true
    }
    return baseline.size === entry.size && Math.abs(baseline.mtimeMs - entry.mtimeMs) <= 1
}

/** changed since that upload: by topic summary when there's one from upload time, else by the gateway's size + mtime */
export function judge(entry: GatewayEntry, baseline: Baseline | undefined, current: TopicSummary | null): Judgement {
    if (current && baselineFits(baseline, entry)) {
        const changes = summaryChanges(baseline.summary, current)
        return { changed: changes.length > 0, changedBy: "summary", changes }
    }
    return { changed: entry.changed, changedBy: "size+mtime", changes: [] }
}

/** uploaded path → its baseline, a JSON file in the app's data dir */
export class Baselines {
    #all: Record<string, Baseline> | null = null

    constructor(public dataDir: string) {}

    get file() {
        return join(this.dataDir, "upload_summaries.json")
    }

    all(): Record<string, Baseline> {
        if (!this.#all) {
            try {
                this.#all = JSON.parse(Deno.readTextFileSync(this.file))
            } catch {
                this.#all = {}
            }
        }
        return this.#all!
    }

    set(path: string, baseline: Baseline) {
        const all = this.all()
        all[path] = baseline
        const temporary = `${this.file}.partial`
        Deno.writeTextFileSync(temporary, JSON.stringify(all, null, 4))
        Deno.renameSync(temporary, this.file)
    }

    /** the uploaded paths that are this recording: itself, and its vN symlinks */
    pathsOf(recording: string): string[] {
        const all = this.all()
        return [
            recording,
            ...Object.keys(all).filter((path) => path !== recording && all[path].recording === recording),
        ]
    }

    /** a symlink named `name` to the recording, in a folder named like the recording's (dimos reads a run's blueprint
     * from its folder's name) */
    async link(recording: string, name: string): Promise<string> {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(recording))
        const hex = [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("")
        const folder = join(this.dataDir, "reuploads", hex, basename(dirname(recording)))
        await Deno.mkdir(folder, { recursive: true })
        const path = join(folder, name)
        await Deno.remove(path).catch(() => {})
        await Deno.symlink(recording, path)
        return path
    }
}

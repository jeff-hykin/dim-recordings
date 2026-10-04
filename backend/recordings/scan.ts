// The recordings folder as a list: .db / .mcap recordings, each with the .rrd files made from it (same folder, same
// base name: go2.db + go2.rrd), and .rrd files nothing claims as standalone rows. Walks one sub-folder deep, like
// Desktop's /recordings (src/recordings.rs), and uses the same ids: the path relative to the folder.
import { join } from "node:path"

export type Format = "db" | "mcap" | "rrd"

export type FileEntry = {
    id: string
    name: string
    format: Format
    size: number
    /** seconds since the epoch */
    modified: number
    path: string
    /** a symlink into somewhere else (read-only use: this app never renames or deletes through one) */
    symlink: boolean
}

export type Listed = FileEntry & {
    /** .rrd files made from this recording */
    rrds: FileEntry[]
    /** an .rrd no .db/.mcap claims */
    standalone?: boolean
}

export const FORMATS: Format[] = ["db", "mcap", "rrd"]

export function formatOfName(name: string): Format | null {
    const extension = name.split(".").pop()?.toLowerCase()
    return FORMATS.find((format) => format === extension) ?? null
}

/** go2_short.db → go2_short */
export function stem(name: string): string {
    return name.replace(/\.(db|mcap|rrd)$/i, "")
}

async function entry(root: string, relative: string): Promise<FileEntry | null> {
    const name = relative.split("/").pop()!
    const format = formatOfName(name)
    if (!format || name.startsWith(".")) {
        return null
    }
    const path = join(root, relative)
    try {
        const link = await Deno.lstat(path)
        const stat = link.isSymlink ? await Deno.stat(path) : link
        if (!stat.isFile) {
            return null
        }
        return {
            id: relative,
            name,
            format,
            size: stat.size,
            modified: (stat.mtime?.getTime() ?? 0) / 1000,
            path,
            symlink: link.isSymlink,
        }
    } catch {
        return null // a dangling symlink, or gone mid-scan
    }
}

export async function scanFiles(root: string): Promise<FileEntry[]> {
    const found: FileEntry[] = []
    const walk = async (relativeDir: string, depth: number) => {
        let entries: Deno.DirEntry[] = []
        try {
            entries = [...Deno.readDirSync(join(root, relativeDir))]
        } catch {
            return
        }
        for (const item of entries) {
            if (item.name.startsWith(".")) {
                continue
            }
            const relative = relativeDir ? `${relativeDir}/${item.name}` : item.name
            if (item.isDirectory) {
                if (depth < 1) {
                    await walk(relative, depth + 1)
                }
                continue
            }
            const file = await entry(root, relative)
            if (file) {
                found.push(file)
            }
        }
    }
    await walk("", 0)
    return found
}

/** Attaches each .rrd to the .db/.mcap of the same folder + base name (both, when a .db and an .mcap share it). */
export function pairRrds(files: FileEntry[]): Listed[] {
    const folderOf = (id: string) => id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : ""
    const key = (file: FileEntry) => `${folderOf(file.id)}\n${stem(file.name)}`
    const recordings: Listed[] = files.filter((file) => file.format !== "rrd").map((file) => ({ ...file, rrds: [] }))
    const byKey = new Map<string, Listed[]>()
    for (const recording of recordings) {
        byKey.set(key(recording), [...(byKey.get(key(recording)) ?? []), recording])
    }
    const out: Listed[] = [...recordings]
    for (const rrd of files.filter((file) => file.format === "rrd")) {
        const owners = byKey.get(key(rrd))
        if (owners) {
            for (const owner of owners) {
                owner.rrds.push(rrd)
            }
        } else {
            out.push({ ...rrd, rrds: [], standalone: true })
        }
    }
    return out
}

/** Refuses ids that leave the folder. */
export function resolveId(root: string, id: string): string {
    if (!id || id.split("/").some((part) => !part || part === "." || part === "..") || id.startsWith("/")) {
        throw new Error(`bad recording id: ${id}`)
    }
    return join(root, id)
}

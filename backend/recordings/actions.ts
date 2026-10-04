// File actions on a recording: rename, delete, duplicate. A .db's SQLite sidecars (-wal, -shm) travel with it, and a
// rename takes the .rrd files made from it along (so they stay paired). A symlinked recording is a link: rename and
// delete act on the link, never on what it points to. Tests: actions_test.ts.
import { dirname, join } from "node:path"
import { formatOfName, stem } from "./scan.ts"

const SIDECARS = ["-wal", "-shm", "-journal"]

function exists(path: string) {
    try {
        Deno.lstatSync(path)
        return true
    } catch {
        return false
    }
}

/** A file name that's safe in one folder: no separators, not hidden, not empty. */
export function cleanName(name: string): string {
    const trimmed = name.trim()
    if (
        !trimmed || trimmed.includes("/") || trimmed.includes("\\") || trimmed.startsWith(".") || trimmed.includes("\0")
    ) {
        throw new Error(`not a usable file name: ${JSON.stringify(name)}`)
    }
    return trimmed
}

/** The new name keeps the recording's extension: "stairs" or "stairs.db" for stairs_old.db → stairs.db. */
export function withExtension(newName: string, oldName: string): string {
    const extension = oldName.slice(oldName.lastIndexOf("."))
    const clean = cleanName(newName)
    return clean.toLowerCase().endsWith(extension.toLowerCase()) ? clean : `${stem(clean)}${extension}`
}

/** Renames path (and its sidecars, and same-stem .rrd files when it's a .db/.mcap); returns the new path. */
export function renameRecording(path: string, newName: string): string {
    const folder = dirname(path)
    const oldName = path.slice(folder.length + 1)
    const name = withExtension(newName, oldName)
    const target = join(folder, name)
    if (target === path) {
        return path
    }
    if (exists(target)) {
        throw new Error(`${name} already exists`)
    }
    const moves: [string, string][] = [[path, target]]
    for (const suffix of SIDECARS) {
        if (exists(path + suffix)) {
            moves.push([path + suffix, target + suffix])
        }
    }
    if (formatOfName(oldName) !== "rrd") {
        const rrd = join(folder, `${stem(oldName)}.rrd`)
        const newRrd = join(folder, `${stem(name)}.rrd`)
        // only when no other recording shares the old stem (go2.db + go2.mcap both own go2.rrd)
        const sibling = ["db", "mcap"].some((format) =>
            `${stem(oldName)}.${format}` !== oldName && exists(join(folder, `${stem(oldName)}.${format}`))
        )
        if (exists(rrd) && !exists(newRrd) && !sibling) {
            moves.push([rrd, newRrd])
        }
    }
    for (const [from, to] of moves) {
        Deno.renameSync(from, to)
    }
    return target
}

export function deleteRecording(path: string) {
    Deno.removeSync(path)
    for (const suffix of SIDECARS) {
        if (exists(path + suffix)) {
            Deno.removeSync(path + suffix)
        }
    }
}

/** "go2 copy.db", then "go2 copy 2.db", ... */
export function copyName(folder: string, name: string): string {
    const extension = name.slice(name.lastIndexOf("."))
    const base = stem(name).replace(/ copy( \d+)?$/, "")
    for (let n = 1;; n++) {
        const candidate = `${base} copy${n === 1 ? "" : ` ${n}`}${extension}`
        if (!exists(join(folder, candidate))) {
            return candidate
        }
    }
}

/** Copies the file (a symlink's target bytes; on APFS a clone, so instant); returns the new path. */
export async function duplicateRecording(path: string, name?: string): Promise<string> {
    const folder = dirname(path)
    const oldName = path.slice(folder.length + 1)
    const target = join(folder, name ? withExtension(name, oldName) : copyName(folder, oldName))
    if (exists(target)) {
        throw new Error(`${target.slice(folder.length + 1)} already exists`)
    }
    const partial = `${folder}/.${target.slice(folder.length + 1)}.partial`
    await Deno.copyFile(path, partial)
    // a .db mid-write keeps recent pages in its WAL; copy that too so the copy is the same recording
    if (exists(`${path}-wal`)) {
        await Deno.copyFile(`${path}-wal`, `${target}-wal`)
    }
    Deno.renameSync(partial, target)
    return target
}

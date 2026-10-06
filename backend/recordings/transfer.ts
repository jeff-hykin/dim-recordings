// Bringing recordings in from a drive: copy or move one file into the recordings folder, never over anything already
// there. It's written under a hidden name (the folder's watcher and the list skip dot files) and renamed into place
// when complete, so a half-copied recording never lists; the copy keeps the source's modified time, so its preview and
// inspection (cached by format + size + mtime) come along. A .db's SQLite sidecars travel with it.
import { basename, join } from "node:path"
import { stem } from "./scan.ts"

const SIDECARS = ["-wal", "-shm"]
const CHUNK = 8 << 20

function exists(path: string) {
    try {
        Deno.lstatSync(path)
        return true
    } catch {
        return false
    }
}

/** `name` in `dir`, else "stem 2.ext", "stem 3.ext", ...: never a name that's taken. */
export function uniqueTarget(dir: string, name: string): string {
    const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")) : ""
    let candidate = join(dir, name)
    for (let n = 2; exists(candidate); n++) {
        candidate = join(dir, `${stem(name)} ${n}${extension}`)
    }
    return candidate
}

/** Free and total bytes of the filesystem holding `dir` (`df -kP`, the same on macOS and Linux); null when unknown. */
export async function diskSpace(dir: string): Promise<{ free: number; total: number } | null> {
    try {
        const { success, stdout } = await new Deno.Command("df", {
            args: ["-kP", dir],
            stdout: "piped",
            stderr: "null",
        })
            .output()
        return success ? parseDf(new TextDecoder().decode(stdout)) : null
    } catch {
        return null
    }
}

export function parseDf(text: string): { free: number; total: number } | null {
    const line = text.trim().split("\n").at(-1)?.trim().split(/\s+/) ?? []
    // Filesystem 1024-blocks Used Available Capacity Mounted-on (the filesystem name may hold spaces: count from the end)
    const at = line.findIndex((field) => /^\d+%$/.test(field))
    if (at < 3) {
        return null
    }
    const total = Number(line[at - 3]) * 1024
    const free = Number(line[at - 1]) * 1024
    return Number.isFinite(total) && Number.isFinite(free) ? { free, total } : null
}

export type TransferProgress = { done: number; total: number }

/** The files that make up a recording: itself plus a .db's sidecars. */
export function partsOf(path: string): string[] {
    return [path, ...(path.toLowerCase().endsWith(".db") ? SIDECARS.map((s) => path + s).filter(exists) : [])]
}

async function copyOne(from: string, to: string, onBytes: (n: number) => void, cancel: () => boolean) {
    const source = await Deno.open(from, { read: true })
    const target = await Deno.open(to, { write: true, createNew: true })
    try {
        const buffer = new Uint8Array(CHUNK)
        while (true) {
            if (cancel()) {
                throw new Error("cancelled")
            }
            const read = await source.read(buffer)
            if (read === null) {
                break
            }
            let written = 0
            while (written < read) {
                written += await target.write(buffer.subarray(written, read))
            }
            onBytes(read)
        }
        await target.syncData()
    } finally {
        source.close()
        target.close()
    }
    const stat = await Deno.stat(from)
    if (stat.mtime) {
        await Deno.utime(to, stat.atime ?? stat.mtime, stat.mtime)
    }
}

/**
 * Copies (or moves: copy, verify the size, then delete the source) `source` into `dir` under `name` (default: its
 * own), never overwriting: a taken name becomes "name 2". Returns the new path.
 */
export async function transferFile(
    source: string,
    dir: string,
    options: {
        mode: "copy" | "move"
        name?: string
        onProgress?: (progress: TransferProgress) => void
        cancel?: () => boolean
    },
): Promise<string> {
    const parts = partsOf(source)
    const sizes = parts.map((part) => Deno.statSync(part).size)
    const total = sizes.reduce((a, b) => a + b, 0)
    const space = await diskSpace(dir)
    if (space && space.free < total + 64 * 1024 * 1024) {
        throw new Error(
            `not enough room in ${dir}: ${(total / 1e9).toFixed(2)} GB needed, ${
                (space.free / 1e9).toFixed(2)
            } GB free`,
        )
    }
    const target = uniqueTarget(dir, options.name ?? basename(source))
    const temporary = (part: string) => join(dir, `.${basename(target)}${part.slice(source.length)}.transferring`)
    let done = 0
    const cancel = options.cancel ?? (() => false)
    try {
        for (const part of parts) {
            await copyOne(part, temporary(part), (n) => {
                done += n
                options.onProgress?.({ done, total })
            }, cancel)
        }
        for (const [i, part] of parts.entries()) {
            if (Deno.statSync(temporary(part)).size !== sizes[i]) {
                throw new Error(`${basename(part)} copied short`)
            }
        }
        // the name was free when picked; take it now only if it still is
        if (exists(target)) {
            throw new Error(`${basename(target)} appeared meanwhile`)
        }
        for (const part of parts) {
            Deno.renameSync(temporary(part), target + part.slice(source.length))
        }
    } catch (error) {
        for (const part of parts) {
            await Deno.remove(temporary(part)).catch(() => {})
        }
        throw error
    }
    if (options.mode === "move") {
        for (const part of parts) {
            Deno.removeSync(part)
        }
    }
    return target
}

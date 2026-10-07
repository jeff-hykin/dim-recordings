// Filesystem calls that can hang: a drive macOS is still asking the user about ("… would like to access files on a
// removable volume" holds every open until it's answered), a dying stick, a stale network mount. Deno's async
// Deno.open still runs its open() on the main thread (a FIFO proves it: every timer stops), so the calls that touch
// drives and recordings run in a worker thread instead, each with a deadline: a call that doesn't answer in time
// rejects with NotResponding, the stuck worker is dropped for a fresh one, and the server keeps answering. Callers
// show "not responding" rather than wait. Tests: tests/slow_fs_test.ts.

/** How long a call may take before it counts as not responding (env DIM_RECORDINGS_FS_TIMEOUT_MS overrides). */
export function fsTimeoutMs(): number {
    const given = Number(Deno.env.get("DIM_RECORDINGS_FS_TIMEOUT_MS"))
    return Number.isFinite(given) && given > 0 ? given : 10_000
}

export class NotResponding extends Error {
    constructor(what: string, ms: number) {
        super(`${what}: no answer in ${(ms / 1000).toFixed(1)} s (macOS may be asking to allow access, or it's stuck)`)
        this.name = "NotResponding"
    }
}

/** `work`, or a NotResponding after `ms` (for promises that are already off the main thread). */
export function within<T>(work: Promise<T>, what: string, ms = fsTimeoutMs()): Promise<T> {
    let timer: number | undefined
    const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new NotResponding(what, ms)), ms)
    })
    return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

// ── the worker ──

// Inline (a blob URL), so the bundled server.js needs no second file. Only plain Deno calls: no imports.
const WORKER = `
const info = (s) => ({
    isFile: s.isFile, isDirectory: s.isDirectory, isSymlink: s.isSymlink, size: s.size,
    mtime: s.mtime?.getTime() ?? null, birthtime: s.birthtime?.getTime() ?? null, ctime: s.ctime?.getTime() ?? null,
})
const ops = {
    async readDir(path) {
        const out = []
        for await (const e of Deno.readDir(path)) {
            out.push({ name: e.name, isFile: e.isFile, isDirectory: e.isDirectory, isSymlink: e.isSymlink })
        }
        return out
    },
    stat: async (path) => info(await Deno.stat(path)),
    lstat: async (path) => info(await Deno.lstat(path)),
    realPath: (path) => Deno.realPath(path),
    async probe(path) {
        (await Deno.open(path, { read: true })).close()
        return true
    },
}
self.onmessage = async ({ data: { id, op, path } }) => {
    try {
        self.postMessage({ id, ok: true, value: await ops[op](path) })
    } catch (error) {
        self.postMessage({ id, ok: false, error: String(error?.message ?? error), notFound: error?.name === "NotFound" })
    }
}
`

type Pending = { op: string; path: string; resolve: (value: unknown) => void; reject: (error: Error) => void }

let worker: Worker | null = null
let workerUrl: string | null = null
const pending = new Map<number, Pending>()
let nextId = 1

function startWorker(): Worker {
    workerUrl ??= URL.createObjectURL(new Blob([WORKER], { type: "application/javascript" }))
    const started = new Worker(workerUrl, { type: "module" })
    started.onmessage = ({ data }) => {
        const call = pending.get(data.id)
        if (!call) {
            return // answered after it was given up on
        }
        pending.delete(data.id)
        if (data.ok) {
            call.resolve(data.value)
        } else {
            const error = new Error(data.error)
            if (data.notFound) {
                error.name = "NotFound"
            }
            call.reject(error)
        }
    }
    started.onerror = (event) => {
        event.preventDefault()
        console.error("slow_fs worker:", event.message)
    }
    return started
}

function send(id: number) {
    const call = pending.get(id)!
    worker ??= startWorker()
    worker.postMessage({ id, op: call.op, path: call.path })
}

/** One call on the worker thread, given up on (with the worker: it's stuck in that call) after `ms`. */
function offThread<T>(op: string, path: string, what: string, ms = fsTimeoutMs()): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const id = nextId++
        const timer = setTimeout(() => {
            if (!pending.delete(id)) {
                return
            }
            // the worker is stuck in this call: drop it, and hand the calls queued behind it to a fresh one
            worker?.terminate()
            worker = null
            for (const queued of pending.keys()) {
                send(queued)
            }
            reject(new NotResponding(what, ms))
        }, ms)
        pending.set(id, {
            op,
            path,
            resolve: (value) => {
                clearTimeout(timer)
                resolve(value as T)
            },
            reject: (error) => {
                clearTimeout(timer)
                reject(error)
            },
        })
        send(id)
    })
}

export type DirItem = { name: string; isFile: boolean; isDirectory: boolean; isSymlink: boolean }
export type FileInfo = {
    isFile: boolean
    isDirectory: boolean
    isSymlink: boolean
    size: number
    /** ms since the epoch */
    mtime: number | null
    birthtime: number | null
    ctime: number | null
}

/** Deno's calls, on the worker thread and bounded (they reject with NotResponding when the path doesn't answer). */
export const fs = {
    readDir: (path: string, ms?: number) => offThread<DirItem[]>("readDir", path, `listing ${path}`, ms),
    stat: (path: string, ms?: number) => offThread<FileInfo>("stat", path, `stat ${path}`, ms),
    lstat: (path: string, ms?: number) => offThread<FileInfo>("lstat", path, `lstat ${path}`, ms),
    realPath: (path: string, ms?: number) => offThread<string>("realPath", path, `resolving ${path}`, ms),
}

/** Opens `path` for reading on the worker and closes it: after this, opening it on the main thread won't hang (the
 * drive answered, macOS's question about it was settled). Rejects with NotResponding when it doesn't answer. */
export function reachable(path: string, ms?: number): Promise<void> {
    return offThread<boolean>("probe", path, `opening ${path}`, ms).then(() => {})
}

/** "Is this name taken" (lstat on the worker). */
export async function exists(path: string): Promise<boolean> {
    try {
        await fs.lstat(path)
        return true
    } catch (error) {
        if (error instanceof NotResponding) {
            throw error
        }
        return false
    }
}

/** Ends the worker (tests, so nothing keeps the process alive). */
export function stopWorker() {
    worker?.terminate()
    worker = null
}

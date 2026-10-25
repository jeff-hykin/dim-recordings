// Every heavy read of a recording (its inspection, its preview, its cloud preview, a .db stream edit) runs here: in a
// child deno with a capped heap, one at a time per lane. A 300 GB file then only slows its own job, never the server's
// answers or the robot: the server's thread never runs a long SQLite call (node:sqlite is synchronous), and a job
// that outgrows its heap dies alone. Background lanes run under `ionice -c 3` (Linux) and `nice -n 19`.
import { buildPreview } from "./cloud_preview.ts"
import { type DbEdit, editDb } from "../replay/edit_db.ts"
import type { Inspection } from "./inspect.ts"
import { inspect } from "./inspect.ts"
import { pathPreview } from "./path_preview.ts"
import { buildThumbnail } from "./thumbnails.ts"

export const CHILD_JOB_FLAG = "--child-job"

const jobs = {
    inspect: (path: string) => inspect(path),
    thumbnail: (path: string, format: "db" | "mcap", inspection: Inspection, folder: string) =>
        buildThumbnail(path, format, inspection, folder),
    pathPreview: (path: string) => pathPreview(path),
    cloudPreview: (path: string) => buildPreview(path),
    editDb: (path: string, edit: DbEdit) => editDb(path, edit),
}
type Jobs = typeof jobs
type JobName = keyof Jobs

/** a file up to this size is a small job: its own lane, so a request that waits on one never waits behind a big one */
export const SMALL_FILE_BYTES = 512 * 1024 * 1024
/** the child's JS heap (MB): its reads are bounded well under it (budget.ts), so past it something is wrong */
const CHILD_HEAP_MB = 1024

/** small / big: background reads by cost, niced, one at a time each; user: someone waits on it (an edit), not niced */
export type Lane = "small" | "big" | "user"

export function laneFor(bytes: number): Lane {
    return bytes <= SMALL_FILE_BYTES ? "small" : "big"
}

export class JobCancelled extends Error {}

type Running = { path: string; child: Deno.ChildProcess; cancelled: boolean }

const lanes: Record<Lane, { running: Running | null; busy: boolean; waiting: { path: string; start: () => void }[] }> =
    {
        small: { running: null, busy: false, waiting: [] },
        big: { running: null, busy: false, waiting: [] },
        user: { running: null, busy: false, waiting: [] },
    }
/** paths whose queued jobs are dropped (a deleted or renamed file), until a new job for them is queued */
const dropped = new Set<string>()

/** One job at a time per lane, in the order asked. */
async function turn<T>(lane: Lane, path: string, work: () => Promise<T>): Promise<T> {
    const state = lanes[lane]
    if (state.busy) {
        await new Promise<void>((start) => state.waiting.push({ path, start }))
    }
    state.busy = true
    try {
        if (dropped.has(path)) {
            throw new JobCancelled(`${path} went away`)
        }
        return await work()
    } finally {
        const next = state.waiting.shift()
        state.busy = !!next
        next?.start()
    }
}

/** Stops the running job on `path` (its child is killed) and drops the queued ones: the file was deleted or renamed. */
export function cancelJobsFor(path: string) {
    dropped.add(path)
    for (const state of Object.values(lanes)) {
        if (state.running?.path === path) {
            state.running.cancelled = true
            try {
                state.running.child.kill("SIGKILL")
            } catch {
                // already gone
            }
        }
    }
}

let wrappers: string[] | undefined

function exists(path: string) {
    try {
        return Deno.statSync(path).isFile
    } catch {
        return false
    }
}

/** ionice (idle class: disk time only when nothing else wants it) and nice, where the system has them */
function lowPriority(): string[] {
    if (wrappers === undefined) {
        const ionice = ["/usr/bin/ionice", "/bin/ionice"].find(exists)
        const nice = ["/usr/bin/nice", "/bin/nice"].find(exists)
        wrappers = [...(ionice ? [ionice, "-c", "3"] : []), ...(nice ? [nice, "-n", "19"] : [])]
    }
    return wrappers
}

/** Runs `name(...args)` in a child deno (its JSON in, its JSON out); `path` is the recording it reads. */
export function inChild<K extends JobName>(
    name: K,
    args: Parameters<Jobs[K]>,
    { lane, path }: { lane: Lane; path: string },
): Promise<Awaited<ReturnType<Jobs[K]>>> {
    dropped.delete(path)
    return turn(lane, path, async (): Promise<unknown> => {
        // this module as a program: in the nix build that's the one bundled server.js, which starts here too (main.ts)
        // a checkout: its own deno.json and lock, as the server was run; the bundle: offline, nothing to resolve
        const fromCheckout = import.meta.url.endsWith("/child_jobs.ts")
        const resolution = fromCheckout
            ? ["--config", new URL("../../deno.json", import.meta.url).pathname]
            : ["--no-lock", "--cached-only"]
        const deno = [
            Deno.execPath(),
            "run",
            "-A",
            ...resolution,
            `--v8-flags=--max-old-space-size=${CHILD_HEAP_MB}`,
            import.meta.url,
            CHILD_JOB_FLAG,
            name,
        ]
        const command = lane === "user" ? deno : [...lowPriority(), ...deno]
        const child = new Deno.Command(command[0], {
            args: command.slice(1),
            stdin: "piped",
            stdout: "piped",
            stderr: "inherit",
        }).spawn()
        const running: Running = { path, child, cancelled: false }
        lanes[lane].running = running
        try {
            const writer = child.stdin.getWriter()
            await writer.write(new TextEncoder().encode(JSON.stringify(args))).catch(() => {})
            await writer.close().catch(() => {})
            const { stdout, code, signal } = await child.output()
            if (running.cancelled) {
                throw new JobCancelled(`${path} went away`)
            }
            // the reply is the last line: anything a library printed to stdout comes before it
            const last = new TextDecoder().decode(stdout).trimEnd().split("\n").pop() ?? ""
            let reply: { value?: unknown; error?: string }
            try {
                reply = JSON.parse(last)
            } catch {
                throw new Error(`its process ended (${signal ?? `code ${code}`}) with no answer`)
            }
            if (reply.error !== undefined) {
                throw new Error(reply.error)
            }
            return reply.value
        } finally {
            lanes[lane].running = null
        }
    }) as Promise<Awaited<ReturnType<Jobs[K]>>>
}

/** The child's side: read the arguments, run the job, print the reply as the last line, exit. */
export async function runChildJob() {
    const name = Deno.args[1] as JobName
    let reply: { value?: unknown; error?: string }
    try {
        const args = JSON.parse(await new Response(Deno.stdin.readable).text()) as unknown[]
        const job = jobs[name] as ((...args: unknown[]) => unknown) | undefined
        if (!job) {
            throw new Error(`no such job: ${name}`)
        }
        reply = { value: (await job(...args)) ?? null }
    } catch (error) {
        reply = { error: error instanceof Error ? error.message : String(error) }
    }
    console.log(`\n${JSON.stringify(reply)}`)
    Deno.exit(0)
}

export const isChildJob = Deno.args[0] === CHILD_JOB_FLAG

// run as this file (a checkout): the job starts here; in the bundled server.js, main.ts starts it once every module is
// loaded (this module loads before some it calls, cloud_preview.ts among them)
if (import.meta.main && isChildJob && import.meta.url.endsWith("/child_jobs.ts")) {
    await runChildJob()
}

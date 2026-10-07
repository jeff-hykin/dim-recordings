// Converting a recording to another format with dtk (`dtk data to_mcap | to_db | to_rrd`), as a job the page follows:
// progress from the converter's own output, the output's tail, the result's path. The new file lands next to the
// original (an .rrd keeps the original's base name, so it lists paired with it).
import { dirname, join } from "node:path"
import { stem } from "./scan.ts"

export type Target = "db" | "mcap" | "rrd"

export type Job = {
    id: string
    kind: "convert"
    recording: string
    from: string
    to: Target
    state: "running" | "done" | "failed" | "cancelled"
    /** 0..1, null when the converter doesn't say */
    progress: number | null
    phase: string
    output: string
    result: string | null
    error: string | null
    started: number
    finished: number | null
}

/** The dtk commit conversions run (jeff/fix/data_conversions): pinned so the app doesn't depend on whatever `dtk` is installed. */
export const DTK_COMMIT = "e7ab39c4c12df78f11cbe71bb572e449958fff19"
export const DTK_URL = `https://raw.githubusercontent.com/jeff-hykin/dtk/${DTK_COMMIT}/main.js`

/** The dtk command: $DIM_RECORDINGS_DTK (e.g. "deno run -A ~/repos/dtk/main.js"), else the pinned commit on this deno. */
export function dtkCommand(): string[] {
    const override = Deno.env.get("DIM_RECORDINGS_DTK")
    if (override) {
        return override.split(/\s+/).filter(Boolean).map((part) => part.replace(/^~/, Deno.env.get("HOME") ?? "~"))
    }
    return [Deno.execPath(), "run", "-A", "--no-config", DTK_URL]
}

/** What a .db or .mcap can become, with the reason when it can't. */
export function conversions(format: string): { to: Target; ok: boolean; reason: string }[] {
    if (format === "rrd") {
        return []
    }
    return (["db", "mcap", "rrd"] as Target[]).filter((to) => to !== format).map((to) => ({
        to,
        ok: true,
        reason: `dtk data to_${to}`,
    }))
}

function exists(path: string) {
    try {
        Deno.lstatSync(path)
        return true
    } catch {
        return false
    }
}

/** stairs.mcap → stairs.db, or "stairs 2.db" when that's taken; an .rrd always takes the base name (it's derived). */
export function outputPath(path: string, to: Target): string {
    const folder = dirname(path)
    const base = stem(path.slice(folder.length + 1))
    if (to === "rrd") {
        return join(folder, `${base}.rrd`)
    }
    for (let n = 1;; n++) {
        const candidate = join(folder, `${base}${n === 1 ? "" : ` ${n}`}.${to}`)
        if (!exists(candidate)) {
            return candidate
        }
    }
}

/** Reads progress out of a converter's output line. */
export function progressOf(
    to: Target,
    line: string,
    totalMessages: number,
    totalStreams: number,
    seen: { streams: number },
) {
    if (to === "rrd") {
        // db_to_rrd: "Processing <stream> ..." per stream, then "<stream> ███░░ 58% [5200/8957]" within it
        const within = line.match(/\[(\d+)\/(\d+)\]/)
        if (within && seen.streams > 0) {
            const fraction = Number(within[1]) / Math.max(1, Number(within[2]))
            return Math.min(0.9, ((seen.streams - 1 + fraction) / Math.max(1, totalStreams)) * 0.9)
        }
        if (/^Processing /.test(line)) {
            seen.streams++
            return Math.min(0.9, seen.streams / Math.max(1, totalStreams) * 0.9)
        }
        return /^Writing /.test(line.trim()) ? 0.95 : null
    }
    const count = line.match(/^\s*(\d+) (messages|rows)\b/)
    if (count && totalMessages > 0) {
        return Math.min(0.99, Number(count[1]) / totalMessages)
    }
    return null
}

export class Jobs {
    jobs = new Map<string, Job & { process?: Deno.ChildProcess }>()
    onChange: (job: Job) => void = () => {}

    list(): Job[] {
        return [...this.jobs.values()].map(({ process: _process, ...job }) => job).sort((a, b) => b.started - a.started)
    }

    get(id: string): Job | undefined {
        const job = this.jobs.get(id)
        if (!job) {
            return undefined
        }
        const { process: _process, ...rest } = job
        return rest
    }

    cancel(id: string) {
        const job = this.jobs.get(id)
        if (job?.state === "running") {
            job.state = "cancelled"
            try {
                job.process?.kill("SIGTERM")
            } catch {
                // already gone
            }
        }
    }

    convert(
        recording: { id: string; path: string; format: string; messages: number; streams: number },
        to: Target,
    ): Job {
        const command = dtkCommand()
        if (recording.format === to || recording.format === "rrd") {
            throw new Error(`can't convert a .${recording.format} to .${to}`)
        }
        const output = outputPath(recording.path, to)
        const partial = to === "rrd"
            ? null
            : join(dirname(output), `.${output.slice(dirname(output).length + 1)}.partial`)
        const verb = { db: ["to_db", recording.path, partial!], mcap: ["to_mcap", recording.path, "-o", partial!] }
        const args = to === "rrd" ? ["data", "to_rrd", recording.path, "--no-open"] : ["data", ...verb[to]]
        const id = crypto.randomUUID().slice(0, 8)
        const job: Job & { process?: Deno.ChildProcess } = {
            id,
            kind: "convert",
            recording: recording.id,
            from: recording.format,
            to,
            state: "running",
            progress: 0,
            phase: "starting",
            output: "",
            result: null,
            error: null,
            started: Date.now() / 1000,
            finished: null,
        }
        this.jobs.set(id, job)
        const process = new Deno.Command(command[0], {
            args: [...command.slice(1), ...args],
            stdout: "piped",
            stderr: "piped",
            env: { NO_COLOR: "1" },
        }).spawn()
        job.process = process
        const seen = { streams: 0 }
        let lastStdout = ""
        const pump = async (stream: ReadableStream<Uint8Array>, isStdout: boolean) => {
            const decoder = new TextDecoder()
            let buffered = ""
            for await (const chunk of stream) {
                buffered += decoder.decode(chunk, { stream: true })
                const lines = buffered.split(/\r?\n|\r/)
                buffered = lines.pop() ?? ""
                for (const line of lines) {
                    if (!line.trim()) {
                        continue
                    }
                    if (isStdout) {
                        lastStdout = line.trim()
                    }
                    job.output = (job.output + line + "\n").slice(-6000)
                    job.phase = line.trim().slice(0, 160)
                    const progress = progressOf(to, line, recording.messages, recording.streams, seen)
                    if (progress !== null) {
                        job.progress = Math.max(job.progress ?? 0, progress)
                    }
                    this.onChange(this.get(id)!)
                }
            }
        }
        Promise.all([pump(process.stdout, true), pump(process.stderr, false), process.status]).then(
            async ([, , status]) => {
                if (job.state === "cancelled") {
                    if (partial) {
                        await Deno.remove(partial).catch(() => {})
                    }
                } else if (!status.success) {
                    job.state = "failed"
                    job.error = job.phase || `dtk exited ${status.code}`
                    if (partial) {
                        await Deno.remove(partial).catch(() => {})
                    }
                } else {
                    try {
                        if (to === "rrd") {
                            // to_rrd keeps its .rrd in dtk's cache and prints its path last: it's moved out, not
                            // copied, so a conversion leaves one .rrd on disk rather than two (dtk rebuilds a missing one)
                            await Deno.remove(output).catch(() => {})
                            await Deno.rename(lastStdout, output).catch(async () => {
                                // another volume: copy, then drop the cache's
                                await Deno.copyFile(lastStdout, output)
                                await Deno.remove(lastStdout).catch(() => {})
                            })
                        } else {
                            await Deno.rename(partial!, output)
                        }
                        job.state = "done"
                        job.result = output
                        job.progress = 1
                        job.phase = `wrote ${output.slice(dirname(output).length + 1)}`
                    } catch (error) {
                        job.state = "failed"
                        job.error = error instanceof Error ? error.message : String(error)
                    }
                }
                job.finished = Date.now() / 1000
                this.onChange(this.get(id)!)
            },
        )
        return this.get(id)!
    }
}

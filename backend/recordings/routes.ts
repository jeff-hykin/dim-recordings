// The recordings API: every action the page offers is one of these, so Desktop's agent can do the same things.
import { dirname } from "node:path"
import { HttpError, type Route } from "../http.ts"
import { deleteRecording, duplicateRecording, renameRecording } from "./actions.ts"
import { conversions, Jobs, type Target } from "./convert.ts"
import { which } from "./foxglove.ts"
import type { Transfers } from "./drive_routes.ts"
import type { Drives } from "./drives.ts"
import { cleanDirs, Library, NotFound, type Recording } from "./library.ts"
import { environment, openIn, type OpenTarget, openTargets, reveal } from "./open.ts"
import { type Order, sections, type SortKey } from "./sort.ts"
import { Thumbnailer } from "./thumb_worker.ts"
import { ffmpeg } from "./thumbnails.ts"
import { topicSummary } from "./reupload.ts"
import { type Uploaded, Uploads } from "./uploads.ts"

export type Services = {
    library: Library
    jobs: Jobs
    thumbnails: Thumbnailer
    uploads: Uploads
    drives: Drives
    transfers: Transfers
}

const ID = {
    id: {
        type: "string",
        required: true,
        description: "recording id: its path inside the recordings folder (.extra/<hash>/<path> for an extra folder's)",
    },
}
const EXTRA_DIRS = {
    type: "string",
    description:
        "the extra folders to scan too, a JSON array of paths (~ is expanded); they stay the extra folders until the next " +
        "call that gives them (the page keeps its list in its own storage and sends it with each list)",
}

export function recordingRoutes({ library, jobs, thumbnails, uploads }: Services): Route[] {
    const find = async (id: string): Promise<Recording> => {
        try {
            return await library.get(id)
        } catch (error) {
            throw error instanceof NotFound ? new HttpError(404, error.message) : error
        }
    }
    const summaryOf = (recording: Recording) =>
        recording.inspection && !recording.inspection.error ? topicSummary(recording.inspection) : null
    const localNames = async () => (await library.files()).map((file) => file.name)
    const row = async (
        recording: Recording,
        env: Awaited<ReturnType<typeof environment>>,
        uploaded: Record<string, Uploaded>,
        names: string[],
    ) => {
        const { inspection, ...rest } = recording
        return {
            ...rest,
            messages: inspection?.messages ?? null,
            // how many things look wrong (the summary's warnings), for the list's flag; null until inspected
            warnings: inspection ? (inspection.warnings ?? []).length : null,
            inspected: recording.format === "rrd" || !!inspection,
            error: inspection?.error ?? null,
            thumbnail: await thumbnails.stateOf(recording),
            opens: openTargets(recording.format, inspection, env),
            conversions: conversions(recording.format),
            uploaded: recording.format === "rrd"
                ? null
                : uploads.status(recording, summaryOf(recording), uploaded, names),
            rrds: recording.rrds.map((rrd) => ({
                ...rrd,
                opens: openTargets("rrd", null, env),
            })),
        }
    }

    return [
        {
            method: "GET",
            path: "api/recordings",
            role: "context",
            description:
                "The recordings folder: each .db/.mcap recording (name, size, duration, when recorded, a stream summary, " +
                "how many warnings, note, preview state, what can open it, the .rrd files made from it) and standalone " +
                ".rrd files, sorted and in " +
                "date sections (Today, Yesterday, This week, Last week, This month, then by month) when sorted by date",
            params: {
                sort: { type: "string", description: "date (default) | size | duration | name" },
                order: { type: "string", description: "desc (default) | asc" },
                tz: {
                    type: "number",
                    description: "the viewer's Date.getTimezoneOffset() in minutes (for Today/Yesterday)",
                },
                extraDirs: EXTRA_DIRS,
            },
            handler: async ({ sort, order, tz, extraDirs }) => {
                if (extraDirs !== undefined) {
                    library.setExtraDirs(cleanDirs(extraDirs))
                }
                const key = (["date", "size", "duration", "name"].includes(String(sort)) ? sort : "date") as SortKey
                const direction = (order === "asc" ? "asc" : "desc") as Order
                const env = await environment(library.config)
                const uploadedMap = await uploads.uploadedByPath()
                const scanned = await library.scan()
                const all = await library.describeAll(scanned.files)
                const names = all.map((recording) => recording.name)
                const rows = await Promise.all(all.map((recording) => row(recording, env, uploadedMap, names)))
                const grouped = sections(rows, key, direction, Date.now() / 1000, Number(tz ?? 0) || 0)
                return {
                    dir: library.dir,
                    extraDirs: scanned.extraDirs,
                    sort: key,
                    order: direction,
                    sections: grouped.map(({ label, items }) => ({ label, recordings: items })),
                    tools: {
                        dtk: true,
                        ffmpeg: !!ffmpeg(),
                        rerun: env.rerunCli,
                        foxglove: env.foxglove,
                        apps: env.apps,
                    },
                    thumbnails: { working: thumbnails.current },
                }
            },
        },
        {
            method: "PUT",
            path: "api/extra-dirs",
            description:
                "Scan these folders too, besides the shared recordings folder (what the page's Settings sets; it keeps the " +
                "list itself): each folder's path, how many recordings it holds, or why it couldn't be read",
            params: {
                dirs: {
                    type: "array",
                    items: { type: "string" },
                    required: true,
                    description: "the folders' paths (~ is expanded); [] scans only the shared folder",
                },
            },
            handler: async ({ dirs }) => {
                library.setExtraDirs(cleanDirs(dirs))
                return { extraDirs: (await library.scan()).extraDirs }
            },
        },
        {
            method: "GET",
            path: "api/recordings/{id}",
            description:
                "One recording in full: the list fields plus its inspection: every stream's type, encoding, count, rate (hz), " +
                "p99 and largest gap, the tf frame tree (edges with rate and first/last time, roots, frames with two parents) " +
                "— what `dtk data summary` prints — and warnings (kind, message, detail, stream/frame, at = seconds in): a " +
                "broken tf tree (two parents, cycle, separate trees, a stream's frame tf never publishes, transforms that stop " +
                "early or start late) and streams with outlier gaps, a rate drop, or a late start / early stop",
            params: ID,
            handler: async ({ id }) => {
                const recording = await find(String(id))
                const env = await environment(library.config)
                return {
                    ...(await row(recording, env, await uploads.uploadedByPath(), await localNames())),
                    inspection: recording.inspection,
                }
            },
        },
        {
            method: "GET",
            path: "api/recordings/{id}/thumbnail",
            description:
                "The preview sprite: its frames side by side (a jpeg; frame count and size in the list's `thumbnail`)",
            params: ID,
            handler: async ({ id }) => {
                const recording = await find(String(id))
                try {
                    return new Response((await thumbnails.sprite(recording)) as Uint8Array<ArrayBuffer>, {
                        headers: { "content-type": "image/jpeg", "cache-control": "max-age=3600" },
                    })
                } catch {
                    throw new HttpError(404, "no preview (yet)")
                }
            },
        },
        {
            method: "PUT",
            path: "api/recordings/{id}/note",
            description: "Set the recording's note (kept in this app's data, not in the file; empty text clears it)",
            params: { ...ID, text: { type: "string", required: true, description: "the note" } },
            handler: async ({ id, text }) => {
                await find(String(id))
                library.setNote(String(id), String(text))
                library.emit({ type: "recordings", reason: "note", id })
                return { ok: true, note: String(text) }
            },
        },
        {
            method: "POST",
            path: "api/recordings/{id}/rename",
            description:
                "Rename a recording (the extension stays; its SQLite sidecars and same-name .rrd follow it, and so does its note)",
            params: {
                ...ID,
                name: { type: "string", required: true, description: "the new name, with or without extension" },
            },
            handler: async ({ id, name }) => {
                const recording = await find(String(id))
                const target = await renameRecording(recording.path, String(name))
                const newId = await library.idOf(target)
                library.moveNote(recording.id, newId)
                library.emit({ type: "recordings", reason: "rename", id: newId })
                return { ok: true, id: newId, path: target }
            },
        },
        {
            method: "DELETE",
            path: "api/recordings/{id}",
            description:
                "Delete a recording file (permanent; the page asks first). A symlinked recording loses only the link. Its .rrd files stay",
            params: ID,
            handler: async ({ id }) => {
                const recording = await find(String(id))
                await deleteRecording(recording.path)
                library.setNote(recording.id, "")
                library.emit({ type: "recordings", reason: "delete", id })
                return { ok: true }
            },
        },
        {
            method: "POST",
            path: "api/recordings/{id}/duplicate",
            description: 'Copy a recording next to itself ("<name> copy.db", or `name`)',
            params: { ...ID, name: { type: "string", description: 'the copy\'s name (default: "<name> copy")' } },
            handler: async ({ id, name }) => {
                const recording = await find(String(id))
                const target = await duplicateRecording(recording.path, name ? String(name) : undefined)
                const newId = await library.idOf(target)
                library.emit({ type: "recordings", reason: "duplicate", id: newId })
                thumbnails.poke()
                return { ok: true, id: newId, path: target }
            },
        },
        {
            method: "POST",
            path: "api/recordings/{id}/convert",
            description:
                "Convert a .db or .mcap to another format with dtk (to = db | mcap | rrd); the new file lands next to it (an " +
                ".rrd under the same name, so it lists with it). Returns a job; follow it with GET api/jobs/{job}",
            params: { ...ID, to: { type: "string", required: true, description: "db | mcap | rrd" } },
            handler: async ({ id, to }) => {
                const recording = await find(String(id))
                if (!["db", "mcap", "rrd"].includes(String(to))) {
                    throw new HttpError(400, "to must be db, mcap or rrd")
                }
                try {
                    return jobs.convert({
                        id: recording.id,
                        path: recording.path,
                        format: recording.format,
                        messages: recording.inspection?.messages ?? 0,
                        streams: recording.inspection?.streams.filter((s) => s.count > 0).length ?? 0,
                    }, String(to) as Target)
                } catch (error) {
                    throw new HttpError(400, error instanceof Error ? error.message : String(error))
                }
            },
        },
        {
            method: "GET",
            path: "api/jobs",
            description:
                "Conversion jobs, newest first: state, progress (0..1), the converter's last line, the result's path",
            handler: () => ({ jobs: jobs.list() }),
        },
        {
            method: "GET",
            path: "api/jobs/{job}",
            description: "One conversion job",
            params: { job: { type: "string", required: true, description: "job id" } },
            handler: ({ job }) =>
                jobs.get(String(job)) ?? (() => {
                    throw new HttpError(404, `no such job: ${job}`)
                })(),
        },
        {
            method: "DELETE",
            path: "api/jobs/{job}",
            description: "Cancel a running conversion (its partial output is removed)",
            params: { job: { type: "string", required: true, description: "job id" } },
            handler: ({ job }) => {
                jobs.cancel(String(job))
                return { ok: true }
            },
        },
        {
            method: "POST",
            path: "api/recordings/{id}/open",
            description:
                "Open a recording: target = replayer (this app's player), map-editor (the dim-map-builder app, when installed), " +
                "foxglove (when installed, for an .mcap whose image/point cloud/camera_info channels are CDR), rerun (an " +
                ".rrd: the Rerun app, else the rerun viewer). The list's `opens` says which are available and why not",
            params: {
                ...ID,
                target: { type: "string", required: true, description: "replayer | map-editor | foxglove | rerun" },
                show: {
                    type: "boolean",
                    description:
                        "switch Desktop's window to the app that opened it (default true); false = load only, the answer's `app` says which",
                },
            },
            handler: async ({ id, target, show }) => {
                const recording = await find(String(id))
                try {
                    return await openIn(
                        library.config,
                        String(target) as OpenTarget["target"],
                        recording,
                        recording.inspection,
                        show !== false,
                    )
                } catch (error) {
                    throw new HttpError(409, error instanceof Error ? error.message : String(error))
                }
            },
        },
        {
            method: "POST",
            path: "api/recordings/{id}/reveal",
            description: "Show the file in Finder (macOS) or the file manager (Linux), on the machine running Desktop",
            params: ID,
            handler: async ({ id }) => {
                const recording = await find(String(id))
                reveal(recording.path)
                return { ok: true, path: recording.path, folder: dirname(recording.path) }
            },
        },
        {
            method: "GET",
            path: "api/recordings/{id}/path",
            description: "The recording's absolute path (what the page's Copy path copies)",
            params: ID,
            handler: async ({ id }) => ({ path: (await find(String(id))).path }),
        },
        {
            method: "POST",
            path: "api/recordings/{id}/upload",
            description:
                "Upload a recording to the Dimensional cloud (Desktop's /dimos-gateway/uploads; queues until logged in). Follow it with " +
                "GET api/uploads; when done the row carries `uploaded.link`",
            params: ID,
            handler: async ({ id }) => {
                const recording = await find(String(id))
                if (recording.format === "rrd") {
                    throw new HttpError(400, "only .db and .mcap recordings upload")
                }
                return await uploads.start(recording.path, recording, summaryOf(recording))
            },
        },
        {
            method: "POST",
            path: "api/recordings/{id}/reupload",
            description:
                "Upload an already uploaded recording again, as name.v2.mcap (then v3, ...; a name.v2 goes up as v3), " +
                "keeping the earlier upload. The row's `uploaded` says whether it changed since (`changed`, by its topic " +
                "summary: each stream's name, type, count and first/last time; `changes` lists what moved) and what it " +
                "would be called (`nextName`). An unchanged one needs force: true",
            params: {
                ...ID,
                force: { type: "boolean", description: "re-upload even when its topic summary hasn't changed" },
            },
            handler: async ({ id, force }) => {
                const recording = await find(String(id))
                if (recording.format === "rrd") {
                    throw new HttpError(400, "only .db and .mcap recordings upload")
                }
                const summary = summaryOf(recording)
                const status = uploads.status(recording, summary, await uploads.uploadedByPath(), await localNames())
                if (!status) {
                    throw new HttpError(400, `${recording.name} hasn't been uploaded from here yet: upload it first`)
                }
                if (await uploads.live(recording.path)) {
                    throw new HttpError(409, `${recording.name} is already uploading`)
                }
                if (!status.changed && force !== true && force !== "true") {
                    throw new HttpError(
                        409,
                        `${recording.name} hasn't changed since it went up as ${status.name} (${status.changedBy}); ` +
                            "pass force: true to upload it again anyway",
                    )
                }
                const path = await uploads.baselines.link(recording.path, status.nextName)
                return { ...(await uploads.start(path, recording, summary)), name: status.nextName }
            },
        },
        {
            method: "POST",
            path: "api/recordings/{id}/cloud-preview",
            description:
                "TEMPORARY: build an uploaded .mcap's console preview here and send it to the cloud (finished .mcap uploads " +
                "get one on their own; this is for ones from before)",
            params: ID,
            handler: async ({ id }) => {
                const recording = await find(String(id))
                const entry = (await uploads.uploadedByPath())[recording.path]
                if (!entry) {
                    throw new HttpError(404, "this recording hasn't been uploaded from here")
                }
                await uploads.previews.force(entry)
                return { ok: true, uploadId: entry.uploadId }
            },
        },
        {
            method: "GET",
            path: "api/uploads",
            description:
                "The uploads tray: each upload's state, phase, bytes, rate and ETA, link when done; whether it waits for login; " +
                "the cloud account",
            handler: () => uploads.tray(),
        },
        {
            method: "DELETE",
            path: "api/uploads/{upload}",
            description: "Cancel a queued or running upload, or remove a finished one from the tray",
            params: { upload: { type: "string", required: true, description: "upload id" } },
            handler: ({ upload }) => uploads.remove(String(upload)),
        },
        {
            method: "POST",
            path: "api/uploads/{upload}/retry",
            description: "Retry a failed or cancelled upload",
            params: { upload: { type: "string", required: true, description: "upload id" } },
            handler: ({ upload }) => uploads.retry(String(upload)),
        },
        {
            method: "GET",
            path: "api/thumbnails",
            description:
                "The preview job: which recording it's working on, and the last results with their wall and CPU time (it runs " +
                "one recording at a time under nice -n 19, pausing between frames)",
            handler: () => ({
                working: thumbnails.current,
                ffmpeg: ffmpeg() ?? null,
                log: thumbnails.log,
                rerun: which("rerun"),
            }),
        },
    ]
}

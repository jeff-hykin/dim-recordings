// The transfer dialog's API: the plugged-in drives with recordings, each file's preview, and copy / move / rename,
// as jobs the page follows (events {type: "transfer", transfer}).
import { basename, dirname } from "node:path"
import { HttpError, type Route } from "../http.ts"
import { renameRecording } from "./actions.ts"
import type { DriveFile, Drives } from "./drives.ts"
import type { Library } from "./library.ts"
import type { Thumbnailer } from "./thumb_worker.ts"
import { diskSpace, transferFile } from "./transfer.ts"

export type Transfer = {
    id: string
    source: string
    name: string
    mode: "copy" | "move"
    state: "queued" | "running" | "done" | "failed" | "cancelled"
    done: number
    total: number
    /** the recording's id in the recordings folder once it's there */
    result: string | null
    error: string | null
}

export class Transfers {
    transfers = new Map<string, Transfer>()
    #cancelled = new Set<string>()
    #queue: Promise<void> = Promise.resolve()
    #next = 1

    constructor(public library: Library, public drives: Drives) {}

    #changed(transfer: Transfer) {
        this.library.emit({ type: "transfer", transfer: { ...transfer } })
    }

    /** Queues one file (they run one at a time: a stick reads fastest that way). */
    start(file: DriveFile, mode: "copy" | "move", name?: string): Transfer {
        const transfer: Transfer = {
            id: `t${this.#next++}`,
            source: file.path,
            name: name ?? file.name,
            mode,
            state: "queued",
            done: 0,
            total: file.size,
            result: null,
            error: null,
        }
        this.transfers.set(transfer.id, transfer)
        this.#changed(transfer)
        this.#queue = this.#queue.then(() => this.#run(transfer, file))
        return transfer
    }

    async #run(transfer: Transfer, file: DriveFile) {
        if (this.#cancelled.has(transfer.id)) {
            return
        }
        transfer.state = "running"
        this.#changed(transfer)
        let last = 0
        try {
            const target = await transferFile(file.path, this.library.dir, {
                mode: transfer.mode,
                name: transfer.name,
                cancel: () => this.#cancelled.has(transfer.id),
                onProgress: ({ done, total }) => {
                    transfer.done = done
                    transfer.total = total
                    if (performance.now() - last > 500) {
                        last = performance.now()
                        this.#changed(transfer)
                    }
                },
            })
            transfer.state = "done"
            transfer.result = target.slice(this.library.dir.length + 1)
            this.library.emit({ type: "recordings", reason: "transfer", id: transfer.result })
        } catch (error) {
            transfer.state = this.#cancelled.has(transfer.id) ? "cancelled" : "failed"
            transfer.error = error instanceof Error ? error.message : String(error)
        }
        this.#changed(transfer)
        if (transfer.mode === "move") {
            await this.drives.scan(file.drive)
            this.drives.onChange()
        }
    }

    cancel(id: string) {
        const transfer = this.transfers.get(id)
        if (!transfer) {
            return false
        }
        this.#cancelled.add(id)
        if (transfer.state === "queued") {
            transfer.state = "cancelled"
            this.#changed(transfer)
        }
        return true
    }
}

export function driveRoutes(
    { library, drives, transfers, thumbnails }: {
        library: Library
        drives: Drives
        transfers: Transfers
        thumbnails: Thumbnailer
    },
): Route[] {
    const find = (path: unknown): DriveFile => {
        const file = drives.file(String(path))
        if (!file) {
            throw new HttpError(404, `not a recording on a plugged-in drive: ${path}`)
        }
        return file
    }
    return [
        {
            method: "GET",
            path: "api/drives",
            role: "context",
            description:
                "Plugged-in removable drives (USB sticks, SD cards) that have recordings on them: each drive's name, mount, " +
                "free space and its .mcap / .db files (path, size, modified, preview state), plus the recordings folder's " +
                "free space and the transfers so far",
            handler: async () => ({
                drives: await Promise.all(
                    drives.list().map(async (drive) => ({
                        ...drive,
                        files: await Promise.all(drive.files.map(async (file) => ({
                            ...file,
                            thumbnail: await thumbnails.stateOf(file),
                        }))),
                    })),
                ),
                destination: { dir: library.dir, ...(await diskSpace(library.dir) ?? { free: null, total: null }) },
                transfers: [...transfers.transfers.values()].reverse(),
            }),
        },
        {
            method: "POST",
            path: "api/drives/rescan",
            description: "Look for drives again and re-read the recordings on each",
            handler: async () => {
                await drives.rescan()
                thumbnails.poke()
                return { ok: true, drives: drives.list().length }
            },
        },
        {
            method: "GET",
            path: "api/drives/thumbnail",
            description: "A drive recording's preview sprite (a jpeg, like api/recordings/{id}/thumbnail)",
            params: { path: { type: "string", required: true, description: "the file's path on the drive" } },
            handler: async ({ path }) => {
                try {
                    return new Response((await thumbnails.sprite(find(path))) as Uint8Array<ArrayBuffer>, {
                        headers: { "content-type": "image/jpeg", "cache-control": "max-age=3600" },
                    })
                } catch (error) {
                    if (error instanceof HttpError) {
                        throw error
                    }
                    throw new HttpError(404, "no preview yet")
                }
            },
        },
        {
            method: "POST",
            path: "api/drives/transfer",
            description:
                "Copy or move recordings from a plugged-in drive into the recordings folder. Never overwrites (a taken " +
                'name becomes "name 2"), refuses when there isn\'t room, and runs one file at a time; returns the ' +
                "transfers, which GET api/drives follows",
            params: {
                paths: { type: "array", required: true, items: { type: "string" }, description: "files on the drive" },
                mode: { type: "string", description: "copy (default) | move (deletes it from the drive once copied)" },
                name: { type: "string", description: "a new name for the copy (only with one path)" },
            },
            handler: async ({ paths, mode, name }) => {
                const files = (Array.isArray(paths) ? paths : [paths]).map(find)
                const how = mode === "move" ? "move" : mode === undefined || mode === "copy" ? "copy" : null
                if (!how) {
                    throw new HttpError(400, "mode is copy or move")
                }
                if (name !== undefined && files.length !== 1) {
                    throw new HttpError(400, "name goes with one path")
                }
                const space = await diskSpace(library.dir)
                const needed = files.reduce((sum, file) => sum + file.size, 0)
                if (space && space.free < needed) {
                    throw new HttpError(
                        507,
                        `not enough room: ${(needed / 1e9).toFixed(2)} GB needed, ${
                            (space.free / 1e9).toFixed(2)
                        } GB free in ${library.dir}`,
                    )
                }
                return { transfers: files.map((file) => transfers.start(file, how, name ? String(name) : undefined)) }
            },
        },
        {
            method: "DELETE",
            path: "api/drives/transfer/{id}",
            description: "Cancel a transfer (a half-copied file is removed; the drive's file is untouched)",
            params: { id: { type: "string", required: true, description: "the transfer id" } },
            handler: ({ id }) => {
                if (!transfers.cancel(String(id))) {
                    throw new HttpError(404, `no transfer ${id}`)
                }
                return { ok: true }
            },
        },
        {
            method: "POST",
            path: "api/drives/rename",
            description:
                "Rename a recording on a plugged-in drive, in place (keeps its extension; refuses a taken name)",
            params: {
                path: { type: "string", required: true, description: "the file's path on the drive" },
                name: { type: "string", required: true, description: "the new name" },
            },
            handler: async ({ path, name }) => {
                const file = find(path)
                const target = renameRecording(file.path, String(name))
                await drives.scan(file.drive)
                drives.onChange()
                return { ok: true, path: target, name: basename(target), folder: dirname(target) }
            },
        },
    ]
}

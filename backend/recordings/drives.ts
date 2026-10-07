// Removable drives with recordings on them (a USB stick out of a lite_record rig, an SD card): which mounted volumes
// are removable, the recordings on each, and one Desktop notification ("Transfer recordings") per drive that's plugged
// in, whose action opens this app on its transfer dialog (#/transfer).
//
// macOS: the folders in /Volumes, each asked once of `diskutil info -plist` (removable, ejectable or not internal; the
// boot volume's link is skipped). Linux: /media/<user>/*, /run/media/<user>/* and /media/* (lite_record's automount),
// with `lsblk`'s RM / HOTPLUG when it's there. $DIM_RECORDINGS_DRIVES (paths separated by ":") adds folders that count
// as drives, for tests and odd mounts. Polled every few seconds by listing those folders: nothing heavier runs unless a
// new one appears. Every call into a drive is async and bounded (slow_fs.ts): a drive that doesn't answer is listed as
// not responding and looked at again once its call comes back, and the rest of the app keeps working.
import { basename, join } from "node:path"
import type { FileEntry } from "./scan.ts"
import { formatOfName } from "./scan.ts"
import { fs, NotResponding, onUnstuck, within } from "./slow_fs.ts"
import { diskSpace } from "./transfer.ts"

export type DriveFile = FileEntry & {
    /** where on the drive: the path under its mount */
    relative: string
    /** the drive's mount */
    drive: string
}

export type Drive = {
    mount: string
    name: string
    /** mount + when it was mounted: a re-plug is a new drive (and a new notification), an app restart isn't */
    key: string
    files: DriveFile[]
    free: number | null
    total: number | null
    scanned: number
    /** "not-responding": a call into it didn't come back (macOS asking to allow access, or a stuck drive) */
    state: "ready" | "not-responding"
    problem: string | null
}

// ── macOS: diskutil ──

/** The top-level keys of a `diskutil info -plist` (booleans, strings, integers). */
export function parsePlist(xml: string): Record<string, string | number | boolean> {
    const out: Record<string, string | number | boolean> = {}
    // the outer dict only: nested dicts/arrays are skipped whole
    const body = xml.slice(xml.indexOf("<dict>") + 6, xml.lastIndexOf("</dict>"))
    const pattern =
        /<key>([^<]*)<\/key>\s*(<true\/>|<false\/>|<string>([^<]*)<\/string>|<integer>(-?\d+)<\/integer>|<(dict|array)>|<(dict|array)\/>|<string\/>)/g
    let depthEnd = 0
    for (const match of body.matchAll(pattern)) {
        if (match.index! < depthEnd) {
            continue
        }
        const [, key, value, text, integer, open] = match
        if (open) {
            // skip to the matching close tag
            let depth = 1
            const tags = new RegExp(`<(/?)${open}>`, "g")
            tags.lastIndex = match.index! + match[0].length
            let tag: RegExpExecArray | null
            while (depth > 0 && (tag = tags.exec(body))) {
                depth += tag[1] ? -1 : 1
            }
            depthEnd = tags.lastIndex
            continue
        }
        out[key] = value === "<true/>"
            ? true
            : value === "<false/>"
            ? false
            : integer !== undefined
            ? Number(integer)
            : text ?? ""
    }
    return out
}

/** A volume a person plugs in: removable media, ejectable, or not internal (a disk image counts: it ejects). */
export function removableFromDiskutil(info: Record<string, string | number | boolean>): boolean {
    if (info.MountPoint === "/" || info.SystemImage === true) {
        return false
    }
    return info.RemovableMediaOrExternalDevice === true || info.Removable === true || info.Ejectable === true ||
        info.Internal === false
}

// ── Linux: lsblk ──

export type BlockDevice = { mounts: string[]; removable: boolean }

/** `lsblk -J -o NAME,RM,HOTPLUG,MOUNTPOINT[,MOUNTPOINTS]` → each mounted device (children too), removable when RM or HOTPLUG. */
export function parseLsblk(json: string): BlockDevice[] {
    // deno-lint-ignore no-explicit-any
    const flag = (value: any) => value === true || value === 1 || value === "1" || value === "true"
    const out: BlockDevice[] = []
    // deno-lint-ignore no-explicit-any
    const walk = (devices: any[], inherited: boolean) => {
        for (const device of devices ?? []) {
            const removable = inherited || flag(device.rm) || flag(device.hotplug)
            const mounts = [device.mountpoint, ...(device.mountpoints ?? [])].filter((m) => typeof m === "string" && m)
            if (mounts.length) {
                out.push({ mounts: [...new Set(mounts as string[])], removable })
            }
            walk(device.children, removable)
        }
    }
    walk(JSON.parse(json).blockdevices ?? [], false)
    return out
}

// ── finding recordings on a drive ──

/** Folders never worth walking on a drive. */
const SKIP_DIRS = new Set([
    "System Volume Information",
    "$RECYCLE.BIN",
    "lost+found",
    "node_modules",
    "Library",
    "Applications",
    "System",
])

/**
 * The .mcap / .db recordings under `root`: `maxDepth` folders down (a lite_record rig writes into a folder or two on
 * the stick), hidden and system folders skipped, at most `maxEntries` directory entries looked at.
 */
export async function scanDrive(root: string, maxDepth = 4, maxEntries = 20000): Promise<DriveFile[]> {
    const found: DriveFile[] = []
    let seen = 0
    const walk = async (relativeDir: string, depth: number) => {
        let entries: Awaited<ReturnType<typeof fs.readDir>>
        try {
            entries = await fs.readDir(join(root, relativeDir))
        } catch (error) {
            if (error instanceof NotResponding) {
                throw error // the drive stopped answering: the whole read is off, not a partial list
            }
            return
        }
        for (const item of entries) {
            if (++seen > maxEntries) {
                return
            }
            if (item.name.startsWith(".") || item.name.startsWith("$") || SKIP_DIRS.has(item.name)) {
                continue
            }
            const relative = relativeDir ? `${relativeDir}/${item.name}` : item.name
            if (item.isDirectory) {
                if (depth < maxDepth) {
                    await walk(relative, depth + 1)
                }
                continue
            }
            const format = formatOfName(item.name)
            if (!item.isFile || (format !== "mcap" && format !== "db")) {
                continue
            }
            const path = join(root, relative)
            try {
                const stat = await fs.stat(path)
                if (stat.size === 0) {
                    continue // a recorder that's just opened it
                }
                found.push({
                    id: path,
                    name: item.name,
                    format,
                    size: stat.size,
                    modified: (stat.mtime ?? 0) / 1000,
                    path,
                    symlink: false,
                    relative,
                    drive: root,
                })
            } catch (error) {
                if (error instanceof NotResponding) {
                    throw error
                }
                // gone mid-scan
            }
        }
    }
    await walk("", 0)
    return found.sort((a, b) => b.modified - a.modified)
}

// ── the watcher ──

async function output(command: string, args: string[]): Promise<string | null> {
    try {
        const { success, stdout } = await new Deno.Command(command, { args, stdout: "piped", stderr: "null" }).output()
        return success ? new TextDecoder().decode(stdout) : null
    } catch {
        return null
    }
}

async function listDirs(parent: string): Promise<string[]> {
    try {
        return (await fs.readDir(parent)).filter((e) => (e.isDirectory || e.isSymlink) && !e.name.startsWith("."))
            .map((e) => join(parent, e.name))
    } catch {
        return []
    }
}

/** The folders that might be drives right now (cheap: a few readdirs of the mount folders, not of the drives). */
export async function candidateMounts(os = Deno.build.os, user = Deno.env.get("USER") ?? ""): Promise<string[]> {
    const extra = (Deno.env.get("DIM_RECORDINGS_DRIVES") ?? "").split(":").filter(Boolean)
    if (os === "darwin") {
        return [...await listDirs("/Volumes"), ...extra]
    }
    const mediaUser = user ? await listDirs(`/media/${user}`) : []
    const media = (await listDirs("/media")).filter((dir) => basename(dir) !== user)
    return [...mediaUser, ...(user ? await listDirs(`/run/media/${user}`) : []), ...media, ...extra]
}

export type Notify = (drive: Drive) => Promise<void> | void

export class Drives {
    drives = new Map<string, Drive>()
    /** keys already notified, kept on disk so an app restart with the stick still in doesn't announce it again */
    #notified: Set<string>
    #removable = new Map<string, boolean>()
    /** mounts with a look still out (a drive that hangs gets one call at a time, not one more per poll) */
    #looking = new Map<string, Promise<void>>()
    /** a drive that didn't answer is asked again after a growing pause (each ask that hangs holds a thread), or as soon
     * as a call that was given up on comes back */
    #retry = new Map<string, { at: number; pause: number }>()
    #timer: number | undefined
    #polling = false
    onChange: () => void = () => {}
    /** where drives might be mounted (tests swap in their own) */
    candidates: () => Promise<string[]> = () => candidateMounts()

    constructor(public dataDir: string, public notify: Notify, public intervalMs = 5000) {
        try {
            this.#notified = new Set(JSON.parse(Deno.readTextFileSync(join(dataDir, "drives_notified.json"))))
        } catch {
            this.#notified = new Set()
        }
    }

    start() {
        onUnstuck(() => {
            this.#retry.clear()
            this.poll()
        })
        this.poll()
        this.#timer = setInterval(() => this.poll(), this.intervalMs)
        Deno.unrefTimer(this.#timer)
    }

    stop() {
        clearInterval(this.#timer)
    }

    /** Drives with recordings on them, and drives that aren't answering (so the page can say so). */
    list(): Drive[] {
        return [...this.drives.values()].filter((drive) => drive.files.length > 0 || drive.state !== "ready")
    }

    files(): DriveFile[] {
        return this.list().flatMap((drive) => drive.files)
    }

    /** The drive file at `path`, or null: transfers only ever touch files a scan found. */
    file(path: string): DriveFile | null {
        return this.files().find((file) => file.path === path) ?? null
    }

    async #isRemovable(mount: string): Promise<boolean> {
        if ((Deno.env.get("DIM_RECORDINGS_DRIVES") ?? "").split(":").includes(mount)) {
            return true
        }
        const known = this.#removable.get(mount)
        if (known !== undefined) {
            return known
        }
        let removable = false
        try {
            if (await fs.realPath(mount) === "/") {
                removable = false // macOS's /Volumes/Macintosh HD
            } else if (Deno.build.os === "darwin") {
                const plist = await output("diskutil", ["info", "-plist", mount])
                removable = plist ? removableFromDiskutil(parsePlist(plist)) : false
            } else {
                const json = await output("lsblk", ["-J", "-o", "NAME,RM,HOTPLUG,MOUNTPOINT"])
                // no lsblk: what's mounted under /media is there because something removable was plugged in
                removable = json
                    ? parseLsblk(json).some((device) => device.removable && device.mounts.includes(mount))
                    : true
            }
        } catch (error) {
            if (error instanceof NotResponding) {
                throw error // not known yet: asked again once the drive answers
            }
            removable = false
        }
        this.#removable.set(mount, removable)
        return removable
    }

    /** Looks at the mounts once: new drives are scanned (and announced), gone ones dropped. Never waits on a drive
     * longer than slow_fs's timeout. */
    async poll(): Promise<void> {
        if (this.#polling) {
            return
        }
        this.#polling = true
        try {
            const listed = await within(this.candidates(), "listing the mounted drives").catch(() => null)
            if (!listed) {
                return // the mount folder itself isn't answering: keep what's known, try again next poll
            }
            const present = new Set(listed)
            let changed = false
            for (const mount of [...this.drives.keys()]) {
                if (!present.has(mount)) {
                    this.drives.delete(mount)
                    this.#removable.delete(mount)
                    changed = true
                }
            }
            for (const mount of present) {
                const known = this.drives.get(mount)
                // a drive already read, a folder that isn't one, a stuck drive whose call is still out: nothing to do
                if (
                    known?.state === "ready" || this.#removable.get(mount) === false ||
                    (known?.state === "not-responding" &&
                        (this.#looking.has(mount) || Date.now() < (this.#retry.get(mount)?.at ?? 0)))
                ) {
                    continue
                }
                await this.#look(mount)
            }
            if (changed) {
                this.onChange()
            }
        } finally {
            this.#polling = false
        }
    }

    /** Whether `mount` is a drive, and its recordings; a drive that doesn't answer in time is listed as not
     * responding, and its look carries on in the background (it lands, and announces, when the call comes back). */
    async #look(mount: string): Promise<void> {
        let look = this.#looking.get(mount)
        if (!look) {
            look = (async () => {
                if (!(await this.#isRemovable(mount))) {
                    return
                }
                const drive = await this.scan(mount)
                this.onChange()
                if (drive.files.length && !this.#notified.has(drive.key)) {
                    this.#notified.add(drive.key)
                    this.#saveNotified()
                    await Promise.resolve(this.notify(drive)).catch((error) => console.error("drives: notify", error))
                }
            })().finally(() => this.#looking.delete(mount))
            look.catch(() => {}) // looked at below, and by the polls that find it still out
            this.#looking.set(mount, look)
        }
        let failure: unknown = null
        await within(look, `reading ${mount}`).catch((error) => failure = error)
        if (failure && !(failure instanceof NotResponding)) {
            console.error("drives:", mount, failure)
        }
        if (this.drives.get(mount)?.state === "ready") {
            this.#retry.delete(mount)
        } else if (failure instanceof NotResponding || this.drives.get(mount)?.state === "not-responding") {
            const pause = Math.min((this.#retry.get(mount)?.pause ?? 15_000) * 2, 300_000)
            this.#retry.set(mount, { at: Date.now() + pause, pause })
        }
        if (failure instanceof NotResponding && this.drives.get(mount)?.state !== "not-responding") {
            this.drives.set(mount, {
                mount,
                name: basename(mount),
                key: `${mount}|stuck`,
                files: [],
                free: null,
                total: null,
                scanned: Date.now() / 1000,
                state: "not-responding",
                problem: "not responding: macOS may be asking on this Mac to allow access to it, or the drive is stuck",
            })
            console.error(`drives: ${mount} isn't answering; looking again once it does`)
            this.onChange()
        }
    }

    /** (Re)reads one drive's recordings and free space (no time limit: callers bound it). */
    async scan(mount: string): Promise<Drive> {
        let mounted = 0
        try {
            const stat = await fs.stat(mount)
            mounted = stat.birthtime ?? stat.ctime ?? stat.mtime ?? 0
        } catch {
            // vanished
        }
        const space = await diskSpace(mount)
        const drive: Drive = {
            mount,
            name: basename(mount),
            key: `${mount}|${mounted}`,
            files: await scanDrive(mount),
            free: space?.free ?? null,
            total: space?.total ?? null,
            scanned: Date.now() / 1000,
            state: "ready",
            problem: null,
        }
        this.drives.set(mount, drive)
        return drive
    }

    /** Re-reads every drive (each bounded like a poll's look). */
    async rescan(): Promise<void> {
        for (const mount of [...this.drives.keys()]) {
            const drive = this.drives.get(mount)
            if (drive?.state === "ready") {
                await within(this.scan(mount), `reading ${mount}`).catch((error) => console.error("drives:", error))
            }
        }
        await this.poll()
        this.onChange()
    }

    #saveNotified() {
        try {
            Deno.mkdirSync(this.dataDir, { recursive: true })
            // the newest few hundred: enough to remember every stick still plugged in
            Deno.writeTextFileSync(
                join(this.dataDir, "drives_notified.json"),
                JSON.stringify([...this.#notified].slice(-300)),
            )
        } catch (error) {
            console.error("drives:", error)
        }
    }
}

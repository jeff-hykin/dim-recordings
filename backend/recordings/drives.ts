// Removable drives with recordings on them (a USB stick out of a lite_record rig, an SD card): which mounted volumes
// are removable, the recordings on each, and one Desktop notification ("Transfer recordings") per drive that's plugged
// in, whose action opens this app on its transfer dialog (#/transfer).
//
// macOS: the folders in /Volumes, each asked once of `diskutil info -plist` (removable, ejectable or not internal; the
// boot volume's link is skipped). Linux: /media/<user>/*, /run/media/<user>/* and /media/* (lite_record's automount),
// with `lsblk`'s RM / HOTPLUG when it's there. $DIM_RECORDINGS_DRIVES (paths separated by ":") adds folders that count
// as drives, for tests and odd mounts. Polled every few seconds by listing those folders: nothing heavier runs unless a
// new one appears.
import { basename, join } from "node:path"
import type { FileEntry } from "./scan.ts"
import { formatOfName } from "./scan.ts"
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
export function scanDrive(root: string, maxDepth = 4, maxEntries = 20000): DriveFile[] {
    const found: DriveFile[] = []
    let seen = 0
    const walk = (relativeDir: string, depth: number) => {
        let entries: Deno.DirEntry[]
        try {
            entries = [...Deno.readDirSync(join(root, relativeDir))]
        } catch {
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
                    walk(relative, depth + 1)
                }
                continue
            }
            const format = formatOfName(item.name)
            if (!item.isFile || (format !== "mcap" && format !== "db")) {
                continue
            }
            const path = join(root, relative)
            try {
                const stat = Deno.statSync(path)
                if (stat.size === 0) {
                    continue // a recorder that's just opened it
                }
                found.push({
                    id: path,
                    name: item.name,
                    format,
                    size: stat.size,
                    modified: (stat.mtime?.getTime() ?? 0) / 1000,
                    path,
                    symlink: false,
                    relative,
                    drive: root,
                })
            } catch {
                // gone mid-scan
            }
        }
    }
    walk("", 0)
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

function listDirs(parent: string): string[] {
    try {
        return [...Deno.readDirSync(parent)].filter((e) => (e.isDirectory || e.isSymlink) && !e.name.startsWith("."))
            .map((e) => join(parent, e.name))
    } catch {
        return []
    }
}

/** The folders that might be drives right now (cheap: a few readdirs). */
export function candidateMounts(os = Deno.build.os, user = Deno.env.get("USER") ?? ""): string[] {
    const extra = (Deno.env.get("DIM_RECORDINGS_DRIVES") ?? "").split(":").filter(Boolean)
    if (os === "darwin") {
        return [...listDirs("/Volumes"), ...extra]
    }
    const mediaUser = user ? listDirs(`/media/${user}`) : []
    const media = listDirs("/media").filter((dir) => basename(dir) !== user)
    return [...mediaUser, ...(user ? listDirs(`/run/media/${user}`) : []), ...media, ...extra]
}

export type Notify = (drive: Drive) => Promise<void> | void

export class Drives {
    drives = new Map<string, Drive>()
    /** keys already notified, kept on disk so an app restart with the stick still in doesn't announce it again */
    #notified: Set<string>
    #removable = new Map<string, boolean>()
    #timer: number | undefined
    #polling = false
    onChange: () => void = () => {}

    constructor(public dataDir: string, public notify: Notify, public intervalMs = 5000) {
        try {
            this.#notified = new Set(JSON.parse(Deno.readTextFileSync(join(dataDir, "drives_notified.json"))))
        } catch {
            this.#notified = new Set()
        }
    }

    start() {
        this.poll()
        this.#timer = setInterval(() => this.poll(), this.intervalMs)
        Deno.unrefTimer(this.#timer)
    }

    stop() {
        clearInterval(this.#timer)
    }

    list(): Drive[] {
        return [...this.drives.values()].filter((drive) => drive.files.length > 0)
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
            if (Deno.realPathSync(mount) === "/") {
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
        } catch {
            removable = false
        }
        this.#removable.set(mount, removable)
        return removable
    }

    /** Looks at the mounts once: new drives are scanned (and announced), gone ones dropped. */
    async poll(): Promise<void> {
        if (this.#polling) {
            return
        }
        this.#polling = true
        try {
            const present = new Set(candidateMounts())
            let changed = false
            for (const mount of [...this.drives.keys()]) {
                if (!present.has(mount)) {
                    this.drives.delete(mount)
                    this.#removable.delete(mount)
                    changed = true
                }
            }
            for (const mount of present) {
                if (this.drives.has(mount) || !(await this.#isRemovable(mount))) {
                    continue
                }
                const drive = await this.scan(mount)
                changed = true
                if (drive.files.length && !this.#notified.has(drive.key)) {
                    this.#notified.add(drive.key)
                    this.#saveNotified()
                    await Promise.resolve(this.notify(drive)).catch((error) => console.error("drives: notify", error))
                }
            }
            if (changed) {
                this.onChange()
            }
        } finally {
            this.#polling = false
        }
    }

    /** (Re)reads one drive's recordings and free space. */
    async scan(mount: string): Promise<Drive> {
        let mounted = 0
        try {
            const stat = Deno.statSync(mount)
            mounted = (stat.birthtime ?? stat.ctime ?? stat.mtime)?.getTime() ?? 0
        } catch {
            // vanished
        }
        const space = await diskSpace(mount)
        const drive: Drive = {
            mount,
            name: basename(mount),
            key: `${mount}|${mounted}`,
            files: scanDrive(mount),
            free: space?.free ?? null,
            total: space?.total ?? null,
            scanned: Date.now() / 1000,
        }
        this.drives.set(mount, drive)
        return drive
    }

    async rescan(): Promise<void> {
        for (const mount of [...this.drives.keys()]) {
            await this.scan(mount)
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

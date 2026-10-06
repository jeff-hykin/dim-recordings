// Plugged-in drives (diskutil / lsblk parsing, the bounded scan, the once-per-drive notification), transfers into the
// recordings folder (copy, move, never overwrite, room check) and the odometry-path preview of a camera-less recording.
import { assert, assertEquals, assertRejects } from "@std/assert"
import { join } from "node:path"
import { Drives, parseLsblk, parsePlist, removableFromDiskutil, scanDrive } from "../backend/recordings/drives.ts"
import { driveNotification } from "../backend/recordings/notify.ts"
import { fitPath, pathPreview, spread } from "../backend/recordings/path_preview.ts"
import { parseDf, transferFile, uniqueTarget } from "../backend/recordings/transfer.ts"
import { encode as lcmEncode } from "../backend/replay/lcm.ts"
import { range, tempDir, writeDb } from "./fixtures.ts"

// `diskutil info -plist /Volumes/TESTREC` for an attached disk image, trimmed (macOS 26)
const DISK_IMAGE_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>APFSContainerFree</key>
	<integer>208179200</integer>
	<key>BusProtocol</key>
	<string>Disk Image</string>
	<key>Ejectable</key>
	<true/>
	<key>Internal</key>
	<false/>
	<key>MediaType</key>
	<string>Generic</string>
	<key>MountPoint</key>
	<string>/Volumes/TESTREC</string>
	<key>APFSPhysicalStores</key>
	<array>
		<dict>
			<key>Internal</key>
			<true/>
		</dict>
	</array>
	<key>Removable</key>
	<true/>
	<key>RemovableMediaOrExternalDevice</key>
	<true/>
	<key>SystemImage</key>
	<false/>
	<key>VolumeName</key>
	<string>TESTREC</string>
</dict>
</plist>`

const BOOT_PLIST = `<plist version="1.0"><dict>
	<key>BusProtocol</key><string>Apple Fabric</string>
	<key>Ejectable</key><false/>
	<key>Internal</key><true/>
	<key>MountPoint</key><string>/</string>
	<key>Removable</key><false/>
	<key>RemovableMediaOrExternalDevice</key><false/>
</dict></plist>`

Deno.test("diskutil: a plugged-in volume counts, the boot disk doesn't, nested dicts don't leak keys", () => {
    const image = parsePlist(DISK_IMAGE_PLIST)
    assertEquals(image.MountPoint, "/Volumes/TESTREC")
    assertEquals(image.APFSContainerFree, 208179200)
    // APFSPhysicalStores' inner Internal=true must not overwrite the top-level Internal=false
    assertEquals(image.Internal, false)
    assert(removableFromDiskutil(image))
    const boot = parsePlist(BOOT_PLIST)
    assertEquals(boot.Internal, true)
    assert(!removableFromDiskutil(boot))
    // an external USB SSD: not "removable media", but not internal either
    assert(removableFromDiskutil({ MountPoint: "/Volumes/T7", Internal: false, Removable: false }))
})

Deno.test("lsblk: removable or hotplug devices with their mounts (children inherit)", () => {
    const json = JSON.stringify({
        blockdevices: [
            {
                name: "nvme0n1",
                rm: false,
                hotplug: false,
                mountpoint: null,
                children: [{ name: "nvme0n1p2", rm: false, hotplug: false, mountpoint: "/" }],
            },
            {
                name: "sda",
                rm: true,
                hotplug: true,
                mountpoint: null,
                children: [{ name: "sda1", rm: false, hotplug: false, mountpoint: "/media/jeff/REC" }],
            },
            // older lsblk: "0"/"1" strings, and MOUNTPOINTS
            { name: "sdb1", rm: "0", hotplug: "1", mountpoints: ["/run/media/jeff/CARD"] },
        ],
    })
    const devices = parseLsblk(json)
    assertEquals(devices.find((d) => d.mounts.includes("/"))?.removable, false)
    assertEquals(devices.find((d) => d.mounts.includes("/media/jeff/REC"))?.removable, true)
    assertEquals(devices.find((d) => d.mounts.includes("/run/media/jeff/CARD"))?.removable, true)
})

Deno.test("scanDrive: .mcap/.db a few folders down, hidden and system folders skipped, depth bounded", async () => {
    const root = await tempDir()
    const write = async (relative: string, bytes = 10) => {
        await Deno.mkdir(join(root, relative, ".."), { recursive: true })
        await Deno.writeFile(join(root, relative), new Uint8Array(bytes))
    }
    await write("rec_1.mcap")
    await write("recordings/lite_record_1788895012.mcap")
    await write("recordings/walk.db")
    await write("a/b/c/d/deep.mcap") // depth 4: found
    await write("a/b/c/d/e/too_deep.mcap") // depth 5: not
    await write(".Spotlight-V100/x.mcap")
    await write(".Trashes/501/old.mcap")
    await write("System Volume Information/x.mcap")
    await write("$RECYCLE.BIN/x.mcap")
    await write("photo.jpg")
    await write("empty.mcap", 0) // a recorder that's just opened it
    const found = scanDrive(root).map((file) => file.relative).sort()
    assertEquals(found, [
        "a/b/c/d/deep.mcap",
        "rec_1.mcap",
        "recordings/lite_record_1788895012.mcap",
        "recordings/walk.db",
    ])
    const one = scanDrive(root).find((file) => file.name === "walk.db")!
    assertEquals(one.drive, root)
    assertEquals(one.format, "db")
    assertEquals(one.path, join(root, "recordings/walk.db"))
})

Deno.test("Drives: a drive from DIM_RECORDINGS_DRIVES is scanned and announced once, even across a restart", async () => {
    const data = await tempDir()
    const stick = await tempDir()
    await Deno.writeFile(join(stick, "rig.mcap"), new Uint8Array(100))
    const previous = Deno.env.get("DIM_RECORDINGS_DRIVES")
    Deno.env.set("DIM_RECORDINGS_DRIVES", stick)
    try {
        const announced: string[] = []
        const drives = new Drives(data, (drive) => {
            announced.push(drive.mount)
        })
        await drives.poll()
        await drives.poll()
        assertEquals(announced, [stick])
        assertEquals(drives.files().map((f) => f.name), ["rig.mcap"])
        assert(drives.file(join(stick, "rig.mcap")))
        assertEquals(drives.file("/etc/passwd"), null)
        // a new process (the app restarted) with the same stick still in: no second notification
        const again = new Drives(data, (drive) => {
            announced.push(drive.mount)
        })
        await again.poll()
        assertEquals(announced, [stick])
        const notice = driveNotification("dim-recordings", drives.list()[0])
        assertEquals(notice.title, "Transfer recordings")
        assertEquals(notice.actions, [["Transfer recordings", "open:dim-recordings/#/transfer"]])
        assert(notice.body.startsWith("1 recording on "))
    } finally {
        previous === undefined
            ? Deno.env.delete("DIM_RECORDINGS_DRIVES")
            : Deno.env.set("DIM_RECORDINGS_DRIVES", previous)
    }
})

Deno.test("transfer: copy keeps the mtime, never overwrites, move deletes the source, sidecars travel", async () => {
    const stick = await tempDir()
    const folder = await tempDir()
    const source = join(stick, "walk.mcap")
    const bytes = new Uint8Array(3 * 1024 * 1024 + 17).map((_, i) => i % 251)
    await Deno.writeFile(source, bytes)
    const old = new Date("2026-09-01T12:00:00Z")
    await Deno.utime(source, old, old)
    const progress: number[] = []

    const first = await transferFile(source, folder, { mode: "copy", onProgress: ({ done }) => progress.push(done) })
    assertEquals(first, join(folder, "walk.mcap"))
    assertEquals(await Deno.readFile(first), bytes)
    assertEquals(Deno.statSync(first).mtime?.getTime(), old.getTime())
    assertEquals(progress.at(-1), bytes.length)

    // the name is taken: "walk 2.mcap", and the first copy is untouched
    const second = await transferFile(source, folder, { mode: "copy" })
    assertEquals(second, join(folder, "walk 2.mcap"))
    assertEquals(uniqueTarget(folder, "walk.mcap"), join(folder, "walk 3.mcap"))

    // move: the copy, then the source goes; a .db's -wal comes along
    const db = join(stick, "drive.db")
    await Deno.writeTextFile(db, "SQLite format 3\0")
    await Deno.writeTextFile(`${db}-wal`, "wal")
    const moved = await transferFile(db, folder, { mode: "move", name: "renamed.db" })
    assertEquals(moved, join(folder, "renamed.db"))
    assertEquals(await Deno.readTextFile(`${moved}-wal`), "wal")
    await assertRejects(() => Deno.stat(db))
    await assertRejects(() => Deno.stat(`${db}-wal`))
    assert(Deno.statSync(source).isFile) // copies leave it

    // nothing half-written is left behind, and nothing hidden lists
    assertEquals([...Deno.readDirSync(folder)].map((e) => e.name).sort(), [
        "renamed.db",
        "renamed.db-wal",
        "walk 2.mcap",
        "walk.mcap",
    ])

    // a cancel removes the partial file
    await assertRejects(() => transferFile(source, folder, { mode: "move", cancel: () => true }), Error, "cancelled")
    assert(Deno.statSync(source).isFile)
    assertEquals([...Deno.readDirSync(folder)].filter((e) => e.name.startsWith(".")), [])
})

Deno.test("df: free and total from the POSIX output, on macOS and Linux", () => {
    const mac = `Filesystem    1024-blocks      Used Available Capacity  Mounted on
/dev/disk7s1       203300       400    203000     1%    /Volumes/TESTREC`
    assertEquals(parseDf(mac), { total: 203300 * 1024, free: 203000 * 1024 })
    const linux = `Filesystem     1024-blocks     Used Available Capacity Mounted on
/dev/sda1         30000000 10000000  20000000      34% /media/jeff/REC STICK`
    assertEquals(parseDf(linux), { total: 30000000 * 1024, free: 20000000 * 1024 })
    assertEquals(parseDf("garbage"), null)
})

Deno.test("path preview: fitted into a unit box with equal aspect, thinned, measured", () => {
    assertEquals(spread(5, 10), [0, 1, 2, 3, 4])
    assertEquals(spread(101, 3), [0, 50, 100])
    // an L: 10 m east, then 5 m north
    const raw: [number, number][] = [
        ...range(0, 101, 0.1).map((x): [number, number] => [x, 0]),
        ...range(0.1, 50, 0.1).map((y): [number, number] => [10, y]),
    ]
    const fitted = fitPath("odom", raw, 40)!
    assertEquals(fitted.points.length, 40)
    assertEquals(fitted.points[0], [0, 0.25]) // centered vertically: 5 m tall in a 10 m box
    assertEquals(fitted.points.at(-1), [1, 0.75])
    assert(Math.abs(fitted.length - 15) < 1e-6)
    assertEquals([fitted.width, fitted.height].map((v) => Math.round(v * 10) / 10), [10, 5])
    assertEquals(fitPath("odom", [[1, 1]]), null)
})

Deno.test("path preview: a camera-less .db's odometry, a still one has none, tf works too", async () => {
    const dir = await tempDir()
    const odometry = (i: number) =>
        lcmEncode("nav_msgs.Odometry", {
            header: { frame_id: "odom" },
            child_frame_id: "base_link",
            pose: { pose: { position: { x: Math.cos(i / 20) * 4, y: Math.sin(i / 20) * 4 }, orientation: { w: 1 } } },
        })
    writeDb(join(dir, "loop.db"), [
        { name: "odom", payload: "dimos.msgs.nav_msgs.Odometry.Odometry", times: range(100, 200, 0.1), blob: odometry },
    ])
    const loop = (await pathPreview(join(dir, "loop.db")))!
    assertEquals(loop.stream, "odom")
    assert(Math.abs(loop.width - 8) < 0.1 && Math.abs(loop.height - 8) < 0.5, `${loop.width} × ${loop.height}`)

    writeDb(join(dir, "still.db"), [
        {
            name: "odom",
            payload: "dimos.msgs.nav_msgs.Odometry.Odometry",
            times: range(100, 50, 0.1),
            blob: () => lcmEncode("nav_msgs.Odometry", { pose: { pose: { position: { x: 1 } } } }),
        },
    ])
    assertEquals(await pathPreview(join(dir, "still.db")), null)

    const tf = (i: number) =>
        lcmEncode("tf2_msgs.TFMessage", {
            transforms: [
                { header: { frame_id: "base_link" }, child_frame_id: "lidar", transform: { translation: { z: 1 } } },
                {
                    header: { frame_id: "world" },
                    child_frame_id: "base_link",
                    transform: { translation: { x: i * 0.1, y: 0 }, rotation: { w: 1 } },
                },
            ],
        })
    writeDb(join(dir, "tf.db"), [
        { name: "tf", payload: "dimos.msgs.tf2_msgs.TFMessage.TFMessage", times: range(100, 30, 0.2), blob: tf },
    ])
    const fromTf = (await pathPreview(join(dir, "tf.db")))!
    assertEquals(fromTf.stream, "tf")
    assert(Math.abs(fromTf.width - 2.9) < 1e-6)
})

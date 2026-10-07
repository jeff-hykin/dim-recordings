// A filesystem call that never comes back (a drive macOS is still asking the user about) must not freeze the app: the
// drive watcher lists the drive as not responding and carries on, and opening a .db that can't be opened fails fast
// while the event loop keeps running.
import { assert, assertEquals, assertRejects } from "@std/assert"
import { join } from "node:path"
import { type Drive, Drives } from "../backend/recordings/drives.ts"
import { fs, NotResponding, stopWorker, within } from "../backend/recordings/slow_fs.ts"
import { openDb } from "../backend/recordings/sqlite.ts"
import { tempDir } from "./fixtures.ts"

Deno.test("within: a call that doesn't answer becomes NotResponding; one that does passes through", async () => {
    assertEquals(await within(Promise.resolve(3), "quick", 50), 3)
    await assertRejects(() => within(new Promise(() => {}), "stuck", 50), NotResponding)
})

Deno.test("Drives: a drive that doesn't answer is listed as not responding, then read once it does", async () => {
    const data = await tempDir()
    let answer: () => void = () => {}
    const answered = new Promise<void>((resolve) => answer = resolve)
    const announced: string[] = []
    class StuckDrives extends Drives {
        override async scan(mount: string): Promise<Drive> {
            await answered // macOS's "allow access to a removable volume?" until the user clicks
            return await super.scan(mount)
        }
    }
    const stick = await tempDir()
    await Deno.writeFile(join(stick, "rig.mcap"), new Uint8Array(100))
    const previous = Deno.env.get("DIM_RECORDINGS_FS_TIMEOUT_MS")
    const previousDrives = Deno.env.get("DIM_RECORDINGS_DRIVES")
    Deno.env.set("DIM_RECORDINGS_FS_TIMEOUT_MS", "200")
    Deno.env.set("DIM_RECORDINGS_DRIVES", stick) // counts as removable without asking diskutil
    try {
        const drives = new StuckDrives(data, (drive) => {
            announced.push(drive.mount)
        })
        drives.candidates = () => Promise.resolve([stick])
        let changes = 0
        drives.onChange = () => changes++

        const started = performance.now()
        await drives.poll()
        assert(performance.now() - started < 2000, "poll waited on the stuck drive")
        assertEquals(drives.list().map((d) => [d.mount, d.state]), [[stick, "not-responding"]])
        assertEquals(drives.files(), [])
        assertEquals(announced, [])

        // more polls while it's still stuck return straight away (one call out per drive, not one more per poll)
        const again = performance.now()
        await drives.poll()
        assert(performance.now() - again < 150, "a poll waited again on a drive whose call is still out")

        // the user allows it: the look that was out lands, the drive is read and announced once
        answer()
        for (let i = 0; i < 50 && drives.list()[0]?.state !== "ready"; i++) {
            await new Promise((resolve) => setTimeout(resolve, 20))
        }
        assertEquals(drives.list().map((d) => [d.mount, d.state]), [[stick, "ready"]])
        assertEquals(drives.files().map((f) => f.name), ["rig.mcap"])
        assertEquals(announced, [stick])
        assert(changes >= 2)
    } finally {
        previous === undefined
            ? Deno.env.delete("DIM_RECORDINGS_FS_TIMEOUT_MS")
            : Deno.env.set("DIM_RECORDINGS_FS_TIMEOUT_MS", previous)
        previousDrives === undefined
            ? Deno.env.delete("DIM_RECORDINGS_DRIVES")
            : Deno.env.set("DIM_RECORDINGS_DRIVES", previousDrives)
    }
})

Deno.test({
    name: "openDb: a .db whose open blocks (a FIFO) fails fast, and the event loop keeps running meanwhile",
    ignore: Deno.build.os === "windows",
    async fn() {
        const dir = await tempDir()
        const fifo = join(dir, "stuck.db")
        const made = await new Deno.Command("mkfifo", { args: [fifo] }).output()
        assert(made.success)
        const previous = Deno.env.get("DIM_RECORDINGS_FS_TIMEOUT_MS")
        Deno.env.set("DIM_RECORDINGS_FS_TIMEOUT_MS", "300")
        let ticks = 0
        const ticker = setInterval(() => ticks++, 20)
        try {
            await assertRejects(() => openDb(fifo), NotResponding)
            assert(ticks >= 5, `the event loop stalled (${ticks} ticks in 300 ms)`)
            // the stuck worker was replaced: the next call answers
            assertEquals((await fs.stat(dir)).isDirectory, true)
        } finally {
            clearInterval(ticker)
            previous === undefined
                ? Deno.env.delete("DIM_RECORDINGS_FS_TIMEOUT_MS")
                : Deno.env.set("DIM_RECORDINGS_FS_TIMEOUT_MS", previous)
            stopWorker()
            // the dropped worker's open is still waiting: a writer from another process lets it finish
            await new Deno.Command("sh", { args: ["-c", 'printf x > "$0"', fifo] }).output()
        }
    },
})

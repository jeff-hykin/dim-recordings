import { assertEquals } from "@std/assert"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { shares, sortRuns, windowsOf } from "../backend/recordings/budget.ts"
import { gapStats } from "../backend/recordings/inspect.ts"
import { idAtOrAfter, idRange, pagesOfIds } from "../backend/recordings/sqlite.ts"
import { streamWarnings } from "../backend/recordings/warnings.ts"
import { range, tempDir, writeDb } from "./fixtures.ts"

Deno.test("shares: small counts get all of theirs, the big ones split what's left", () => {
    assertEquals(shares([10, 1000, 20, 5000], 1000), [10, 485, 20, 485])
    assertEquals(shares([3, 4], 100), [3, 4])
    assertEquals(shares([], 100), [])
})

Deno.test("windowsOf: whole when it fits, else windows from the start to the end", () => {
    assertEquals(windowsOf(10, 20), [[0, 10]])
    const windows = windowsOf(1000, 40, 4)
    assertEquals(windows, [[0, 10], [330, 10], [660, 10], [990, 10]])
})

Deno.test("sortRuns: each run between NaNs sorted, the NaNs stay", () => {
    const sorted = Array.from(sortRuns(Float64Array.from([3, 1, 2, NaN, 9, 7])))
    assertEquals(sorted.map((v) => Number.isNaN(v) ? "-" : v), [1, 2, 3, "-", 7, 9])
})

Deno.test("windowed times: no gap spans the stretch between windows, a real gap in one is found", () => {
    // 10 Hz for 1000 s read as two windows of 100 s; the second has a 5 s outage
    const first = range(0, 1000, 0.1)
    const second = [...range(900, 500, 0.1), ...range(955, 450, 0.1)]
    const times = Float64Array.from([...first, NaN, ...second])
    const stats = gapStats("x", 10_000, times)
    assertEquals([stats.start, Math.round(stats.end! * 10) / 10, Math.round(stats.maxGap * 10) / 10], [0, 999.9, 5.1])
    const warnings = streamWarnings("x", times, 0, 1000)
    assertEquals(warnings.map((w) => w.kind), ["gap"])
})

Deno.test("sqlite: id range, id pages with a stride, the id at a time without a scan", async () => {
    const dir = await tempDir()
    const path = join(dir, "r.db")
    writeDb(path, [{ name: "odom", payload: "dimos.msgs.nav_msgs.Odometry", times: range(100, 1000, 0.5) }])
    const db = new DatabaseSync(path, { readOnly: true })
    try {
        assertEquals(idRange(db, "odom"), { low: 1, high: 1000 })
        const every = [...pagesOfIds<{ id: number; ts: number }>(db, "ts", '"odom"', [1, 1001], { every: 10 })].flat()
        assertEquals(every.length, 100)
        assertEquals(every.slice(0, 2).map((r) => r.id), [1, 11])
        assertEquals(idAtOrAfter(db, "odom", 100), 1)
        assertEquals(idAtOrAfter(db, "odom", 110.2), 22)
        assertEquals(idAtOrAfter(db, "odom", 10_000), null)
    } finally {
        db.close()
        await Deno.remove(dir, { recursive: true })
    }
})

import { assertEquals } from "@std/assert"
import { dateSection, sections, sortRecordings } from "../backend/recordings/sort.ts"

// Sunday 2026-10-04 15:00 UTC; tz 0 unless said
const NOW = Date.UTC(2026, 9, 4, 15, 0) / 1000
const at = (y: number, m: number, d: number, h = 12) => Date.UTC(y, m - 1, d, h) / 1000

Deno.test("date sections: today, yesterday, this week (from Monday), last week, this month, then months", () => {
    assertEquals(dateSection(at(2026, 10, 4, 1), NOW), "Today")
    assertEquals(dateSection(at(2026, 10, 3), NOW), "Yesterday")
    assertEquals(dateSection(at(2026, 9, 28), NOW), "This week") // Monday
    assertEquals(dateSection(at(2026, 9, 27), NOW), "Last week") // Sunday before
    assertEquals(dateSection(at(2026, 9, 21), NOW), "Last week")
    assertEquals(dateSection(at(2026, 9, 20), NOW), "September")
    assertEquals(dateSection(at(2026, 5, 6), NOW), "May")
    assertEquals(dateSection(at(2025, 12, 31), NOW), "December 2025")
    assertEquals(dateSection(NOW + 3600, NOW), "Today") // a clock that ran ahead
})

Deno.test("date sections: this month sits between last week and the month list", () => {
    const now = Date.UTC(2026, 9, 28, 12) / 1000 // Wednesday Oct 28
    assertEquals(dateSection(at(2026, 10, 26), now), "This week")
    assertEquals(dateSection(at(2026, 10, 20), now), "Last week")
    assertEquals(dateSection(at(2026, 10, 18), now), "This month")
    assertEquals(dateSection(at(2026, 10, 1), now), "This month")
    assertEquals(dateSection(at(2026, 9, 30), now), "September")
})

Deno.test("date sections follow the viewer's timezone", () => {
    // 2026-10-04 02:00 UTC is still Oct 3 in Los Angeles (UTC-7: getTimezoneOffset() = 420)
    const now = Date.UTC(2026, 9, 4, 20) / 1000
    assertEquals(dateSection(Date.UTC(2026, 9, 4, 2) / 1000, now, 0), "Today")
    assertEquals(dateSection(Date.UTC(2026, 9, 4, 2) / 1000, now, 420), "Yesterday")
})

const items = [
    { name: "a.db", size: 300, duration: 10, recorded: at(2026, 10, 4) },
    { name: "b.mcap", size: 100, duration: null, recorded: at(2026, 10, 3) },
    { name: "c.db", size: 200, duration: 600, recorded: at(2026, 5, 6) },
    { name: "d.db", size: 200, duration: 30, recorded: at(2026, 9, 29) },
]

Deno.test("sort by size, duration, date, both ways; ties newest first", () => {
    assertEquals(sortRecordings(items, "size", "desc").map((i) => i.name), ["a.db", "d.db", "c.db", "b.mcap"])
    assertEquals(sortRecordings(items, "size", "asc").map((i) => i.name), ["b.mcap", "d.db", "c.db", "a.db"])
    assertEquals(sortRecordings(items, "duration", "desc").map((i) => i.name), ["c.db", "d.db", "a.db", "b.mcap"])
    assertEquals(sortRecordings(items, "duration", "asc").map((i) => i.name), ["b.mcap", "a.db", "d.db", "c.db"])
    assertEquals(sortRecordings(items, "date", "asc").map((i) => i.name), ["c.db", "d.db", "b.mcap", "a.db"])
})

Deno.test("sections: grouped by date when sorting by date (oldest group first when ascending), one group otherwise", () => {
    assertEquals(
        sections(items, "date", "desc", NOW).map((s) => [s.label, s.items.map((i) => i.name)]),
        [["Today", ["a.db"]], ["Yesterday", ["b.mcap"]], ["This week", ["d.db"]], ["May", ["c.db"]]],
    )
    assertEquals(sections(items, "date", "asc", NOW).map((s) => s.label), ["May", "This week", "Yesterday", "Today"])
    assertEquals(sections(items, "size", "desc", NOW).map((s) => s.label), [null])
})

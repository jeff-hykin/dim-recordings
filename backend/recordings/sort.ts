// Sorting the list, and Inbox-style date sections: Today, Yesterday, This week, Last week, This month, then a
// section per month. Pure functions (tests: sort_test.ts).

export type SortKey = "date" | "size" | "duration" | "name"
export type Order = "asc" | "desc"

export type Sortable = { name: string; size: number; duration: number | null; recorded: number }

export function sortRecordings<T extends Sortable>(items: T[], key: SortKey, order: Order): T[] {
    const value = (item: T): number | string => {
        switch (key) {
            case "size":
                return item.size
            case "duration":
                return item.duration ?? -1
            case "name":
                return item.name.toLowerCase()
            default:
                return item.recorded
        }
    }
    const sign = order === "asc" ? 1 : -1
    return [...items].sort((a, b) => {
        const x = value(a)
        const y = value(b)
        const primary = typeof x === "string" ? x.localeCompare(y as string) : x - (y as number)
        // ties (an unknown duration, two equal sizes) fall back to newest first, then name, so the order is stable
        return sign * primary || b.recorded - a.recorded || a.name.localeCompare(b.name)
    })
}

const DAY = 86400

const MONTHS = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
]

/**
 * The section a time falls in, seen from `now`. `tzOffset` is the viewer's `Date.getTimezoneOffset()` (minutes west
 * of UTC), so "today" is the viewer's day, not the server's. Weeks start on Monday.
 */
export function dateSection(time: number, now: number, tzOffset = 0): string {
    const shift = -tzOffset * 60
    const local = (t: number) => new Date((t + shift) * 1000)
    const today = local(now)
    const startToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) / 1000 - shift
    const weekday = (today.getUTCDay() + 6) % 7 // Monday = 0
    const startWeek = startToday - weekday * DAY
    const startMonth = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1) / 1000 - shift
    if (time >= startToday) {
        return "Today" // the future too (a clock that ran ahead)
    }
    if (time >= startToday - DAY) {
        return "Yesterday"
    }
    if (time >= startWeek) {
        return "This week"
    }
    if (time >= startWeek - 7 * DAY) {
        return "Last week"
    }
    if (time >= startMonth) {
        return "This month"
    }
    const then = local(time)
    const month = MONTHS[then.getUTCMonth()]
    return then.getUTCFullYear() === today.getUTCFullYear() ? month : `${month} ${then.getUTCFullYear()}`
}

export type Section<T> = { label: string | null; items: T[] }

/** Sorted items in sections: by date when sorting by date, else one unlabeled section. */
export function sections<T extends Sortable>(
    items: T[],
    key: SortKey,
    order: Order,
    now: number,
    tzOffset = 0,
): Section<T>[] {
    const sorted = sortRecordings(items, key, order)
    if (key !== "date") {
        return [{ label: null, items: sorted }]
    }
    const out: Section<T>[] = []
    for (const item of sorted) {
        const label = dateSection(item.recorded, now, tzOffset)
        if (out.at(-1)?.label === label) {
            out.at(-1)!.items.push(item)
        } else {
            out.push({ label, items: [item] })
        }
    }
    return out
}

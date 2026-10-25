// Opening a memory2 .db to read. A read-only SQLite open still writes the WAL index (-shm) next to the file; when
// there's no un-checkpointed WAL to read, `immutable=1` reads without touching anything beside the file (which matters
// for a symlink into someone's data folder). A stream table's `ts` has no index, so nothing here sorts or scans by it:
// rows are read by id (the rowid), which counts up in arrival order.
import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { fs, reachable } from "./slow_fs.ts"

/** The SQLite open itself is synchronous (the main thread): the file is first reached with bounded async calls, so a
 * .db on a drive that isn't answering fails fast instead of freezing the app. */
export async function openDb(path: string): Promise<DatabaseSync> {
    const real = await fs.realPath(path)
    await reachable(real)
    let walBytes = 0
    try {
        walBytes = (await fs.stat(`${real}-wal`)).size
    } catch {
        // no WAL
    }
    if (walBytes > 0) {
        return new DatabaseSync(real, { readOnly: true })
    }
    const uri = `file:${real.split("/").map(encodeURIComponent).join("/")}?immutable=1`
    return new DatabaseSync(uri, { readOnly: true })
}

export function quoteName(name: string) {
    return `"${name.replaceAll('"', '""')}"`
}

/** rows a page reads at once: node:sqlite's `iterate()` segfaults deno (2.5, 2.6) past ~100k rows, so pages of `.all()` */
export const PAGE_ROWS = 20_000

/** A stream table's first and last id (two rowid lookups, not a scan); null when it's empty. memory2 ids count up from
 * the first message and nothing deletes single rows, so `high - low + 1` is its count. */
export function idRange(db: DatabaseSync, table: string): { low: number; high: number } | null {
    const row = db.prepare(`SELECT min(id) AS low, max(id) AS high FROM ${quoteName(table)}`).get() as {
        low: number | null
        high: number | null
    }
    return row.low === null || row.high === null ? null : { low: row.low, high: row.high }
}

/** Rows with id in [from, to), a page at a time in id order; `every` > 1 keeps one id in that many. */
export function* pagesOfIds<T extends { id: number }>(
    db: DatabaseSync,
    select: string,
    from: string,
    range: [number, number],
    { idColumn = "id", every = 1 }: { idColumn?: string; every?: number } = {},
): Generator<T[]> {
    const stride = Math.max(1, Math.floor(every))
    const kept = stride > 1 ? ` AND (${idColumn} - ?) % ${stride} = 0` : ""
    const page = db.prepare(
        `SELECT ${idColumn} AS id, ${select} FROM ${from} WHERE ${idColumn} >= ? AND ${idColumn} < ?${kept} ` +
            `ORDER BY ${idColumn}`,
    )
    for (let low = range[0]; low < range[1]; low += PAGE_ROWS * stride) {
        const high = Math.min(range[1], low + PAGE_ROWS * stride)
        const params: SQLInputValue[] = stride > 1 ? [low, high, range[0]] : [low, high]
        const rows = page.all(...params) as T[]
        if (rows.length) {
            yield rows
        }
    }
}

/** The first id whose ts is at or after `time`, by bisecting ids (ts follows arrival order, near enough); null past
 * the end. log2(rows) rowid lookups instead of a scan of the table. */
export function idAtOrAfter(db: DatabaseSync, table: string, time: number): number | null {
    const range = idRange(db, table)
    if (!range) {
        return null
    }
    const at = db.prepare(`SELECT id, ts FROM ${quoteName(table)} WHERE id >= ? ORDER BY id LIMIT 1`)
    let low = range.low
    let high = range.high + 1
    while (low < high) {
        const middle = Math.floor((low + high) / 2)
        const row = at.get(middle) as { id: number; ts: number } | undefined
        if (!row || row.ts >= time) {
            high = middle
        } else {
            low = row.id + 1
        }
    }
    return low > range.high ? null : (at.get(low) as { id: number } | undefined)?.id ?? null
}

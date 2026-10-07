// Opening a memory2 .db to read. A read-only SQLite open still writes the WAL index (-shm) next to the file; when
// there's no un-checkpointed WAL to read, `immutable=1` reads without touching anything beside the file (which matters
// for a symlink into someone's data folder).
import { DatabaseSync } from "node:sqlite"
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

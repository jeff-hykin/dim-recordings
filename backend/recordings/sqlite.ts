// Opening a memory2 .db to read. A read-only SQLite open still writes the WAL index (-shm) next to the file; when
// there's no un-checkpointed WAL to read, `immutable=1` reads without touching anything beside the file (which matters
// for a symlink into someone's data folder).
import { DatabaseSync } from "node:sqlite"

export function openDb(path: string): DatabaseSync {
    const real = Deno.realPathSync(path)
    let walBytes = 0
    try {
        walBytes = Deno.statSync(`${real}-wal`).size
    } catch {
        // no WAL
    }
    if (walBytes > 0) {
        return new DatabaseSync(real, { readOnly: true })
    }
    const uri = `file:${real.split("/").map(encodeURIComponent).join("/")}?immutable=1`
    return new DatabaseSync(uri, { readOnly: true })
}

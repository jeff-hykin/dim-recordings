// Rename, delete or duplicate one stream of a memory2 .db, in place (dtk's db_rename.js / db_delete.js / db_cp.js).
// A stream is a family of tables (`<name>`, `<name>_blob`, `<name>_vec`, `<name>_rtree` + the r-tree's shadow tables)
// and one `_streams` row; nothing else names it. Rename = ALTER TABLE + one UPDATE (no copying, whatever the size);
// delete = DROP TABLE + one DELETE (SQLite reuses the freed pages; the file doesn't shrink); duplicate = the stream
// and blob tables copied inside the same file under the new name, plus its `_streams` row. All in one transaction.
import { DatabaseSync } from "node:sqlite"

export type DbEdit =
    | { op: "rename"; stream: string; to: string }
    | { op: "delete"; stream: string }
    | { op: "duplicate"; stream: string; to: string }

const FAMILY = ["", "_blob", "_vec", "_rtree"]
const SHADOWS = ["_rtree_node", "_rtree_parent", "_rtree_rowid"]

export const STREAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

const q = (name: string) => `"${name.replaceAll('"', '""')}"`

export function editDb(path: string, edit: DbEdit): { rows: number } {
    const db = new DatabaseSync(Deno.realPathSync(path))
    try {
        const tables = new Map(
            (db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'")
                .all() as {
                    name: string
                    sql: string
                }[])
                .map((row) => [row.name, row.sql ?? ""]),
        )
        const inRegistry = (db.prepare("SELECT COUNT(*) AS n FROM _streams WHERE name = ?").get(
            edit.stream,
        ) as { n: number }).n > 0
        if (!inRegistry && !tables.has(edit.stream)) {
            throw new Error(`no stream ${edit.stream}`)
        }
        const family = FAMILY.map((suffix) => edit.stream + suffix).filter((name) => tables.has(name))
        const virtual = family.filter((name) =>
            /^\s*CREATE\s+VIRTUAL/i.test(tables.get(name)!) &&
            /\bvec0\b/i.test(tables.get(name)!)
        )
        if (edit.op !== "duplicate" && virtual.length) {
            // sqlite-vec's tables can only be altered with its extension loaded, which this app doesn't ship
            throw new Error(
                `${edit.stream} has an embedding index (${
                    virtual.join(", ")
                }, a sqlite-vec table) that only dimos can ${edit.op}; use \`dtk data topic ${edit.op}\``,
            )
        }
        if (edit.op !== "delete") {
            if (!STREAM_NAME.test(edit.to)) {
                throw new Error(
                    `"${edit.to}" isn't a usable stream name (letters, digits and _, not starting with a digit)`,
                )
            }
            const taken = FAMILY.map((suffix) => edit.to + suffix).filter((name) => tables.has(name))
            const registered = (db.prepare("SELECT COUNT(*) AS n FROM _streams WHERE name = ?").get(
                edit.to,
            ) as { n: number }).n > 0
            if (taken.length || registered) {
                throw new Error(`there is already a stream named ${edit.to}`)
            }
        }
        let rows = 0
        db.exec("BEGIN IMMEDIATE")
        try {
            if (edit.op === "rename") {
                for (const name of family) {
                    // the r-tree's shadow tables follow their virtual table
                    db.exec(
                        `ALTER TABLE ${q(name)} RENAME TO ${q(edit.to + name.slice(edit.stream.length))}`,
                    )
                }
                db.prepare("UPDATE _streams SET name = ? WHERE name = ?").run(
                    edit.to,
                    edit.stream,
                )
            } else if (edit.op === "delete") {
                if (tables.has(edit.stream)) {
                    rows = (db.prepare(`SELECT COUNT(*) AS n FROM ${q(edit.stream)}`)
                        .get() as { n: number }).n
                }
                for (const name of family) {
                    db.exec(`DROP TABLE IF EXISTS ${q(name)}`)
                }
                for (const suffix of SHADOWS) {
                    db.exec(`DROP TABLE IF EXISTS ${q(edit.stream + suffix)}`)
                }
                db.prepare("DELETE FROM _streams WHERE name = ?").run(edit.stream)
            } else {
                // the stream table and its blobs (what db_cp copies); its pose r-tree and embedding index aren't copied
                for (const suffix of ["", "_blob"]) {
                    const from = edit.stream + suffix
                    if (!tables.has(from)) {
                        continue
                    }
                    const to = edit.to + suffix
                    const ddl = tables.get(from)!.replace(
                        /^(\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)("(?:[^"]|"")+"|\[[^\]]+\]|`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)/i,
                        (_all, prefix) => `${prefix}${q(to)}`,
                    )
                    db.exec(ddl)
                    const copied = db.prepare(
                        `INSERT INTO ${q(to)} SELECT * FROM ${q(from)}`,
                    ).run()
                    if (suffix === "") {
                        rows = Number(copied.changes)
                    }
                }
                const columns = (db.prepare("PRAGMA table_info(_streams)").all() as {
                    name: string
                }[]).map((c) => c.name)
                const list = columns.map(q).join(", ")
                const values = columns.map((column) => column === "name" ? "?" : q(column)).join(", ")
                db.prepare(
                    `INSERT INTO _streams (${list}) SELECT ${values} FROM _streams WHERE name = ?`,
                ).run(
                    edit.to,
                    edit.stream,
                )
            }
            db.exec("COMMIT")
        } catch (error) {
            db.exec("ROLLBACK")
            throw error
        }
        return { rows }
    } finally {
        db.close()
    }
}

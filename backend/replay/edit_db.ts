// Rename, delete or duplicate one stream of a memory2 .db, in place (dtk's db_rename.js / db_delete.js / db_cp.js).
// A stream is a family of tables and one `_streams` row; nothing else names it:
//   <name>         the messages (id, ts, pose, tags)        <name>_blob   their payloads
//   <name>_rtree   the pose index (an r-tree virtual table, with _node / _parent / _rowid shadow tables)
//   <name>_vec     the embedding index (a sqlite-vec `vec0` virtual table, with _info / _chunks / _rowids /
//                  _vector_chunksNN shadow tables), on streams dimos embeds (e.g. color_image_embedded)
// rename: ALTER TABLE for the plain tables and the r-tree (its shadows follow); a vec0 table doesn't rename its shadow
//   tables (sqlite-vec 0.1.6), so it is rebuilt under the new name: same declaration, rows copied, old one dropped.
// delete: DROP TABLE for each (the virtual tables drop their shadows) + the `_streams` row. The file doesn't shrink;
//   SQLite reuses the pages.
// duplicate: every table of the family copied under the new name inside the same file (the r-tree and vec0 recreated
//   from their declarations and filled), plus a `_streams` row: a complete stream.
// All in one transaction. sqlite-vec is loaded from DIM_RECORDINGS_SQLITE_VEC (the nix build sets it to nixpkgs'
// sqlite-vec); without it a stream with an embedding index can't be edited (and says so).
import { DatabaseSync } from "node:sqlite"

export type DbEdit =
    | { op: "rename"; stream: string; to: string }
    | { op: "delete"; stream: string }
    | { op: "duplicate"; stream: string; to: string }

const FAMILY = ["", "_blob", "_rtree", "_vec"]
/** shadow tables a virtual table leaves if it was dropped without its module (cleanup only) */
const SHADOWS = ["_rtree_node", "_rtree_parent", "_rtree_rowid"]

export const STREAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

const q = (name: string) => `"${name.replaceAll('"', '""')}"`

/** the sqlite-vec extension's path, when this machine has one (the nix build sets it) */
export function sqliteVecPath(): string | null {
    return Deno.env.get("DIM_RECORDINGS_SQLITE_VEC") || null
}

/** A writable connection, with sqlite-vec loaded when it's available. */
export function openWritable(path: string): { db: DatabaseSync; vec: boolean } {
    const vecPath = sqliteVecPath()
    const db = new DatabaseSync(Deno.realPathSync(path), { readOnly: false, allowExtension: !!vecPath })
    let vec = false
    if (vecPath) {
        try {
            db.loadExtension(vecPath)
            vec = true
        } catch (error) {
            console.error(`sqlite-vec didn't load from ${vecPath}:`, error)
        }
    }
    return { db, vec }
}

/** `CREATE VIRTUAL TABLE "x" USING vec0(...)` → the column names in the parentheses (rowid not included) */
function vecColumns(sql: string): string[] {
    const inside = sql.slice(sql.indexOf("(") + 1, sql.lastIndexOf(")"))
    const columns: string[] = []
    let depth = 0
    let part = ""
    for (const char of inside + ",") {
        if (char === "[" || char === "(") {
            depth++
        } else if (char === "]" || char === ")") {
            depth--
        }
        if (char === "," && depth === 0) {
            const name = part.trim().replace(/^\+/, "").split(/\s+/)[0]?.replace(/^"|"$/g, "")
            if (name) {
                columns.push(name)
            }
            part = ""
        } else {
            part += char
        }
    }
    return columns
}

/** The table's declaration with its name swapped for `to`. */
function renamedDeclaration(sql: string, to: string): string {
    return sql.replace(
        /^(\s*CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)("(?:[^"]|"")+"|\[[^\]]+\]|`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)/i,
        (_all, prefix) => `${prefix}${q(to)}`,
    )
}

/** Copies table `from` into a new table `to` (same declaration; a vec0 table is filled by its columns). */
function copyTable(db: DatabaseSync, sql: string, from: string, to: string): number {
    db.exec(renamedDeclaration(sql, to))
    if (/\bUSING\s+vec0\b/i.test(sql)) {
        const columns = ["rowid", ...vecColumns(sql)].map(q).join(", ")
        return Number(db.prepare(`INSERT INTO ${q(to)} (${columns}) SELECT ${columns} FROM ${q(from)}`).run().changes)
    }
    return Number(db.prepare(`INSERT INTO ${q(to)} SELECT * FROM ${q(from)}`).run().changes)
}

export function editDb(path: string, edit: DbEdit): { rows: number; tables: string[] } {
    const { db, vec } = openWritable(path)
    try {
        const tables = new Map(
            (db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all() as {
                name: string
                sql: string
            }[])
                .map((row) => [row.name, row.sql ?? ""]),
        )
        const registered = (name: string) =>
            (db.prepare("SELECT COUNT(*) AS n FROM _streams WHERE name = ?").get(name) as { n: number }).n > 0
        if (!registered(edit.stream) && !tables.has(edit.stream)) {
            throw new Error(`no stream ${edit.stream}`)
        }
        const family = FAMILY.map((suffix) => edit.stream + suffix).filter((name) => tables.has(name))
        const isVec = (name: string) => /\bUSING\s+vec0\b/i.test(tables.get(name) ?? "")
        const vecTables = family.filter(isVec)
        if (vecTables.length && !vec) {
            throw new Error(
                `${edit.stream} has an embedding index (${vecTables.join(", ")}, a sqlite-vec table) and sqlite-vec ` +
                    "isn't available here (DIM_RECORDINGS_SQLITE_VEC); use `dtk data topic`",
            )
        }
        if (edit.op !== "delete") {
            if (!STREAM_NAME.test(edit.to)) {
                throw new Error(
                    `"${edit.to}" isn't a usable stream name (letters, digits and _, not starting with a digit)`,
                )
            }
            const taken = [...FAMILY, ...SHADOWS].map((suffix) => edit.to + suffix).filter((name) => tables.has(name))
            if (taken.length || registered(edit.to)) {
                throw new Error(`there is already a stream named ${edit.to}`)
            }
        }
        const target = (name: string) => edit.op === "delete" ? "" : edit.to + name.slice(edit.stream.length)
        let rows = 0
        if (tables.has(edit.stream)) {
            rows = (db.prepare(`SELECT COUNT(*) AS n FROM ${q(edit.stream)}`).get() as { n: number }).n
        }
        db.exec("BEGIN IMMEDIATE")
        try {
            if (edit.op === "rename") {
                for (const name of family) {
                    if (isVec(name)) {
                        copyTable(db, tables.get(name)!, name, target(name))
                        db.exec(`DROP TABLE ${q(name)}`)
                    } else {
                        db.exec(`ALTER TABLE ${q(name)} RENAME TO ${q(target(name))}`)
                    }
                }
                db.prepare("UPDATE _streams SET name = ? WHERE name = ?").run(edit.to, edit.stream)
            } else if (edit.op === "delete") {
                for (const name of family) {
                    db.exec(`DROP TABLE IF EXISTS ${q(name)}`)
                }
                for (const suffix of SHADOWS) {
                    db.exec(`DROP TABLE IF EXISTS ${q(edit.stream + suffix)}`)
                }
                db.prepare("DELETE FROM _streams WHERE name = ?").run(edit.stream)
            } else {
                for (const name of family) {
                    copyTable(db, tables.get(name)!, name, target(name))
                }
                const columns = (db.prepare("PRAGMA table_info(_streams)").all() as { name: string }[]).map((c) =>
                    c.name
                )
                const values = columns.map((column) => column === "name" ? "?" : q(column)).join(", ")
                db.prepare(
                    `INSERT INTO _streams (${columns.map(q).join(", ")}) SELECT ${values} FROM _streams WHERE name = ?`,
                )
                    .run(edit.to, edit.stream)
            }
            db.exec("COMMIT")
        } catch (error) {
            db.exec("ROLLBACK")
            throw error
        }
        return { rows, tables: family.map((name) => edit.op === "delete" ? name : target(name)) }
    } finally {
        db.close()
    }
}

// The selected recording's summary (the right-side panel on a desktop, a full-width sheet on a phone): what looks wrong
// (in red, first), its streams (type, encoding, count, rate, gaps) and tf frame tree, like `dtk data summary`, plus its
// note (saved in the app's data, not the file).
import { useEffect, useRef, useState } from "react"
import {
    api,
    bytes,
    duration,
    gap,
    type Inspection,
    type Recording,
    type TfEdge,
    type TfTree,
    type Warning,
} from "../api.ts"

// `dtk data summary --html` colors p99 and gap by how many times the stream's average interval they are, on a log scale
// where 1× (even spacing) is calm and 20× is saturated: log10(ratio) / log10(20). Its three thirds become the theme's
// status colors: even (< 2.7×) ok, uneven (2.7–7.4×) warn, gappy (≥ 7.4×) danger (Portal has no red: a filled warn).
// Count and hz are dtk's other heat: magnitude on a log scale against the busiest stream, drawn as a bar under the number.
const EVEN = 20 ** (1 / 3)
const GAPPY = 20 ** (2 / 3)
type Level = "ok" | "warn" | "bad" | ""
const gapLevel = (ratio: number): Level => !(ratio > 0) ? "" : ratio < EVEN ? "ok" : ratio < GAPPY ? "warn" : "bad"
const logShare = (value: number, max: number) => value > 0 && max > 0 ? Math.log10(value + 1) / Math.log10(max + 1) : 0

function Legend() {
    return (
        <p className="rate-legend small muted" data-testid="rate-legend">
            <span className="mono">p99 · gap</span> vs the average interval:
            <span className="lvl ok">even &lt; {EVEN.toFixed(1)}×</span>
            <span className="lvl warn">uneven</span>
            <span className="lvl bad">gappy ≥ {GAPPY.toFixed(1)}×</span>
            <span className="legend-bar">
                <span className="count-bar" />
            </span>
            count, hz (log, vs the busiest stream)
        </p>
    )
}

/** +m:ss after the recording's start */
function offset(seconds: number): string {
    const s = Math.max(0, Math.round(seconds))
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const ss = String(s % 60).padStart(2, "0")
    return h ? `+${h}:${String(m).padStart(2, "0")}:${ss}` : `+${m}:${ss}`
}

const rate = (hz: number) => hz >= 10 ? `${Math.round(hz)} Hz` : `${hz.toFixed(1)} Hz`

/** What looks wrong, first thing in the summary, in red; nothing wrong is one quiet line. */
function Warnings({ warnings }: { warnings: Warning[] }) {
    const [all, setAll] = useState(false)
    if (!warnings.length) {
        return (
            <p className="no-issues small muted" data-testid="no-issues">
                No issues found
            </p>
        )
    }
    const LIMIT = 6
    const shown = all ? warnings : warnings.slice(0, LIMIT)
    return (
        <section className="warnings" role="alert" data-testid="warnings">
            <p className="warnings-head">
                {warnings.length} {warnings.length === 1 ? "warning" : "warnings"}
            </p>
            <ul>
                {shown.map((w, i) => (
                    <li key={i} data-kind={w.kind}>
                        <span className="w-message">{w.message}</span>
                        <span className="w-detail mono">{w.detail}</span>
                    </li>
                ))}
            </ul>
            {warnings.length > LIMIT && (
                <button
                    type="button"
                    className="dim-btn sm ghost w-more"
                    onClick={() => setAll(!all)}
                >
                    {all ? "fewer" : `${warnings.length - LIMIT} more`}
                </button>
            )}
        </section>
    )
}

/**
 * The tf frames as an indented tree, each child with its transform's rate (or static) and, when it stops early or
 * starts late, when; sized to the whole tree up to 60% of the view, then it scrolls.
 */
export function Tree(
    { tf, start, warnings }: {
        tf: TfTree
        start: number | null
        warnings: Warning[]
    },
) {
    if (!tf.source) {
        return <p className="muted small">No tf stream.</p>
    }
    if (!tf.edges.length) {
        return <p className="muted small">No frames in {tf.source}.</p>
    }
    const children = new Map<string, TfEdge[]>()
    for (const edge of tf.edges) {
        children.set(edge.parent, [...(children.get(edge.parent) ?? []), edge])
    }
    const conflicted = new Set(tf.conflicts.map((c) => c.frame))
    const flagged = new Set(
        warnings.filter((w) => w.message.startsWith("TF:") && w.frame).map((w) => w.frame!),
    )
    const end = Math.max(...tf.edges.map((edge) => edge.last))
    const lines: { prefix: string; frame: string; edge: TfEdge | null }[] = []
    const walk = (
        frame: string,
        edge: TfEdge | null,
        prefix: string,
        last: boolean,
        path: Set<string>,
    ) => {
        const depth = path.size
        lines.push({
            prefix: depth === 0 ? "" : prefix + (last ? "└ " : "├ "),
            frame,
            edge,
        })
        if (path.has(frame)) {
            return
        }
        const kids = (children.get(frame) ?? []).sort((a, b) => a.child.localeCompare(b.child))
        kids.forEach((kid, i) =>
            walk(
                kid.child,
                kid,
                depth === 0 ? "" : prefix + (last ? "  " : "│ "),
                i === kids.length - 1,
                new Set(path).add(frame),
            )
        )
    }
    const roots = tf.roots.length ? tf.roots : [tf.edges[0].parent]
    roots.forEach((root) => walk(root, null, "", true, new Set()))
    const frames = new Set(tf.edges.flatMap((edge) => [edge.parent, edge.child])).size
    const meta = (edge: TfEdge | null) => {
        if (!edge) {
            return ""
        }
        if (edge.static) {
            return "static"
        }
        const parts = [edge.hz > 0 ? rate(edge.hz) : `${edge.count}×`]
        if (
            start !== null &&
            end - edge.last > Math.max(1, edge.hz > 0 ? 10 / edge.hz : 1)
        ) {
            parts.push(`until ${offset(edge.last - start)}`)
        }
        return parts.join(" · ")
    }
    return (
        <>
            <p className="muted small mono">
                {tf.source} · {frames} frames · {tf.messages.toLocaleString()} {tf.messages === 1 ? "msg" : "msgs"}
                {tf.coverage && tf.coverage !== "all of it" ? ` · read ${tf.coverage}` : ""}
            </p>
            <div className="tree mono" data-testid="tf-tree">
                {lines.map((line, i) => {
                    const bad = conflicted.has(line.frame) || flagged.has(line.frame)
                    return (
                        <div
                            key={i}
                            className={`tf-line ${bad ? "bad" : !line.prefix ? "root" : ""}`}
                        >
                            <span
                                className="tf-name"
                                title={line.edge ? `${line.edge.parent} → ${line.frame}` : line.frame}
                            >
                                <span className="muted">{line.prefix}</span>
                                {line.frame}
                                {conflicted.has(line.frame) && <span>(2 parents)</span>}
                            </span>
                            <span className="tf-meta">{meta(line.edge)}</span>
                        </div>
                    )
                })}
            </div>
            {tf.conflicts.map((c) => (
                <p key={c.frame} className="small bad mono">
                    {c.frame} ← {c.parents.map((p) => `${p.parent} (${p.count})`).join(" | ")}
                </p>
            ))}
        </>
    )
}

export function SummaryPanel(
    { recording, sheet, onClose }: {
        recording: Recording
        sheet: boolean
        onClose: () => void
    },
) {
    const [inspection, setInspection] = useState<Inspection | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [note, setNote] = useState(recording.note)
    const [saved, setSaved] = useState<"saved" | "saving" | null>(null)
    const timer = useRef<number | undefined>(undefined)
    useEffect(() => {
        setInspection(null)
        setError(null)
        setNote(recording.note)
        api.get(recording.id).then(
            (full) => setInspection(full.inspection),
            (e) => setError(String(e.message ?? e)),
        )
    }, [recording.id])
    const save = (text: string) => {
        clearTimeout(timer.current)
        setSaved("saving")
        timer.current = setTimeout(() => {
            api.setNote(recording.id, text).then(
                () => setSaved("saved"),
                (e) => setError(String(e.message ?? e)),
            )
        }, 500)
    }
    const maxCount = Math.max(
        1,
        ...(inspection?.streams ?? []).map((s) => s.count),
    )
    const maxHz = Math.max(0, ...(inspection?.streams ?? []).map((s) => s.hz))
    const panel = (
        <aside
            className={`summary dim-card ${sheet ? "sheet" : ""}`}
            aria-label="Summary"
            data-testid="summary"
        >
            <header>
                <div>
                    <p className="section-head">Summary</p>
                    <p className="summary-name mono">{recording.name}</p>
                </div>
                <button
                    type="button"
                    className={`dim-btn sm ${sheet ? "" : "ghost"}`}
                    onClick={onClose}
                    aria-label="close"
                    title="close (Esc)"
                >
                    {sheet ? "Close" : "✕"}
                </button>
            </header>
            {inspection && <Warnings warnings={inspection.warnings ?? []} />}
            <dl className="facts">
                <dt>size</dt>
                <dd className="mono">{bytes(recording.size)}</dd>
                <dt>duration</dt>
                <dd className="mono">{duration(recording.duration)}</dd>
                <dt>recorded</dt>
                <dd className="mono">
                    {new Date(recording.recorded * 1000).toLocaleString()}
                    {recording.recordedFrom === "mtime" && <span className="muted">(file time)</span>}
                </dd>
                <dt>messages</dt>
                <dd className="mono">{inspection?.messages.toLocaleString() ?? "…"}</dd>
                <dt>path</dt>
                <dd className="mono path">
                    {recording.path}
                    {recording.symlink && <span className="muted">(symlink)</span>}
                </dd>
            </dl>
            <label className="note">
                <span className="dim-label">
                    Notes {saved && <span className="muted">· {saved}</span>}
                </span>
                <textarea
                    className="dim-textarea"
                    placeholder="What's in this recording? (kept in the app, not the file)"
                    value={note}
                    onChange={(event) => {
                        setNote(event.target.value)
                        save(event.target.value)
                    }}
                />
            </label>
            {error && <p className="error small">{error}</p>}
            <p className="dim-label">Streams</p>
            {!inspection ? <p className="muted small">reading…</p> : (
                <table className="dim-table streams">
                    <colgroup>
                        <col className="c-name" />
                        <col className="c-type" />
                        <col className="c-count" />
                        <col className="c-hz" />
                        <col className="c-p99" />
                        <col className="c-gap" />
                    </colgroup>
                    <thead>
                        <tr>
                            <th>stream</th>
                            <th className="t-type">type</th>
                            <th className="num">count</th>
                            <th className="num">hz</th>
                            <th
                                className="num"
                                title="99th percentile gap between messages"
                            >
                                p99
                            </th>
                            <th
                                className="num"
                                title="largest gap, and how many times the average interval"
                            >
                                gap
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {inspection.streams.map((s) => (
                            <tr key={s.name} className={s.count ? "" : "empty-stream"}>
                                <td
                                    className="mono"
                                    title={`${s.name}: ${s.type} (${s.encoding})`}
                                >
                                    {s.name}
                                </td>
                                <td
                                    className="mono muted t-type"
                                    title={`${s.type} (${s.encoding})`}
                                >
                                    {s.type.split(".").pop()}
                                    <span
                                        className={`enc ${s.encoding === "cdr" ? "cdr" : ""}`}
                                    >
                                        {s.encoding}
                                    </span>
                                </td>
                                <td className="num mono">
                                    <span
                                        className="count-bar"
                                        style={{ width: `${logShare(s.count, maxCount) * 100}%` }}
                                    />
                                    {s.count.toLocaleString()}
                                </td>
                                <td className="num mono">
                                    <span
                                        className="count-bar"
                                        style={{ width: `${logShare(s.hz, maxHz) * 100}%` }}
                                    />
                                    {s.hz > 0 ? s.hz.toFixed(1) : "—"}
                                </td>
                                <td
                                    className={`num mono lvl ${gapLevel(s.p99Ratio)}`}
                                    title={s.p99Gap > 0 ? `${s.p99Ratio.toFixed(1)}× the average interval` : ""}
                                >
                                    {gap(s.p99Gap)}
                                </td>
                                <td
                                    className={`num mono lvl ${gapLevel(s.gapRatio)}`}
                                    title={s.maxGap > 0 ? `${s.gapRatio.toFixed(1)}× the average interval` : ""}
                                >
                                    {gap(s.maxGap)}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            {inspection && <Legend />}
            <p className="dim-label">tf frames</p>
            {inspection && (
                <Tree
                    tf={inspection.tf}
                    start={inspection.start}
                    warnings={inspection.warnings ?? []}
                />
            )}
        </aside>
    )
    return sheet
        ? (
            <div
                className="sheet-scrim"
                onClick={(event) => event.target === event.currentTarget && onClose()}
            >
                {panel}
            </div>
        )
        : panel
}

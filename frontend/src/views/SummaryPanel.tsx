// The right-side panel: a recording's streams (type, encoding, count, rate, gaps) and tf frame tree, like `dtk data
// summary`, plus its note (saved in the app's data, not the file).
import { useEffect, useRef, useState } from "react"
import { api, bytes, duration, gap, type Inspection, type Recording, type TfTree } from "../api.ts"

function Tree({ tf }: { tf: TfTree }) {
    if (!tf.source) {
        return <p className="muted small">No tf stream.</p>
    }
    if (!tf.edges.length) {
        return (
            <p className="muted small">
                No frames in the first {tf.seconds} s of {tf.source}.
            </p>
        )
    }
    const children = new Map<string, string[]>()
    for (const edge of tf.edges) {
        children.set(edge.parent, [
            ...(children.get(edge.parent) ?? []),
            edge.child,
        ])
    }
    const conflicted = new Set(tf.conflicts.map((c) => c.frame))
    const lines: { prefix: string; frame: string }[] = []
    const walk = (
        frame: string,
        prefix: string,
        last: boolean,
        path: Set<string>,
        depth: number,
    ) => {
        lines.push({
            prefix: depth === 0 ? "" : prefix + (last ? "`- " : "|- "),
            frame,
        })
        if (path.has(frame)) {
            return
        }
        const kids = (children.get(frame) ?? []).sort()
        kids.forEach((kid, i) =>
            walk(
                kid,
                depth === 0 ? "" : prefix + (last ? "   " : "|  "),
                i === kids.length - 1,
                new Set(path).add(frame),
                depth + 1,
            )
        )
    }
    const roots = tf.roots.length ? tf.roots : [tf.edges[0].parent]
    roots.forEach((root) => walk(root, "", true, new Set(), 0))
    return (
        <>
            <p className="muted small mono">
                {tf.source} · first {tf.seconds} s · {tf.messages} msgs
            </p>
            <pre className="tree mono">
                {lines.map((line, i) => (
                    <div key={i} className={conflicted.has(line.frame) ? "warn" : i === 0 || !line.prefix ? "root" : ""}>
                        <span className="muted">{line.prefix}</span>
                        {line.frame}
                        {conflicted.has(line.frame) && <span className="warn"> (2 parents)</span>}
                    </div>
                ))}
            </pre>
            {tf.conflicts.map((c) => (
                <p key={c.frame} className="small warn mono">
                    {c.frame} ← {c.parents.map((p) => `${p.parent} (${p.count})`).join(" | ")}
                </p>
            ))}
        </>
    )
}

export function SummaryPanel(
    { recording, pinned, onClose, onEnter, onLeave }: {
        recording: Recording
        pinned: boolean
        onClose: () => void
        onEnter: () => void
        onLeave: () => void
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
    return (
        <aside
            className="summary dim-card"
            onMouseEnter={onEnter}
            onMouseLeave={onLeave}
            aria-label="Summary"
        >
            <header>
                <div>
                    <p className="section-head">Summary</p>
                    <p className="summary-name mono">{recording.name}</p>
                </div>
                {pinned && (
                    <button
                        type="button"
                        className="dim-btn ghost sm"
                        onClick={onClose}
                        aria-label="close"
                    >
                        ✕
                    </button>
                )}
            </header>
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
                                <td className="mono" title={`${s.name}: ${s.type} (${s.encoding})`}>{s.name}</td>
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
                                        style={{
                                            width: `${
                                                (Math.log10(s.count + 1) / Math.log10(maxCount + 1)) *
                                                100
                                            }%`,
                                        }}
                                    />
                                    {s.count.toLocaleString()}
                                </td>
                                <td className="num mono">
                                    {s.hz > 0 ? s.hz.toFixed(1) : "—"}
                                </td>
                                <td className={`num mono ${s.p99Ratio > 3 ? "warn" : ""}`}>
                                    {gap(s.p99Gap)}
                                </td>
                                <td
                                    className={`num mono ${s.gapRatio > 5 ? "warn" : ""}`}
                                    title={s.maxGap > 0 ? `${s.gapRatio.toFixed(1)}× the average interval` : ""}
                                >
                                    {gap(s.maxGap)}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            <p className="dim-label">tf frames</p>
            {inspection && <Tree tf={inspection.tf} />}
        </aside>
    )
}

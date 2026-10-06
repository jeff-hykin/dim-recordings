// What looks wrong in a recording, shown first in its summary: a broken tf tree (dtk tools/tf_check.js's checks) and
// streams with outlier gaps, a sagging rate, or a late start / early stop against the rest of the recording.

export type Warning = {
    /** tf: two parents · cycle · forest · stops early · starts late · published once · unplaced;
     * a stream: gap · rate drop · starts late · stops early */
    kind: string
    /** one short line: "odom: 3 gaps, longest 4.2 s" */
    message: string
    /** the numbers behind it: "at +1:23, +2:05 · usually every 0.10 s" */
    detail: string
    stream?: string
    frame?: string
    /** seconds after the recording's start, where it happens */
    at?: number
}

export type EdgeSpan = {
    parent: string
    child: string
    count: number
    first: number
    last: number
    hz: number
    static: boolean
}

/** +m:ss (or +h:mm:ss) after the recording's start */
export function offset(seconds: number): string {
    const s = Math.max(0, Math.round(seconds))
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const ss = String(s % 60).padStart(2, "0")
    return h ? `+${h}:${String(m).padStart(2, "0")}:${ss}` : `+${m}:${ss}`
}

export function seconds(value: number): string {
    if (value < 0.001) {
        return `${Math.round(value * 1e6)} µs`
    }
    return value >= 100
        ? `${Math.round(value)} s`
        : value >= 10
        ? `${value.toFixed(1)} s`
        : value >= 1
        ? `${value.toFixed(2)} s`
        : `${(value * 1000).toFixed(0)} ms`
}

const hz = (rate: number) =>
    rate >= 10000 ? `${Math.round(rate / 1000)} kHz` : rate >= 10 ? `${Math.round(rate)} Hz` : `${rate.toFixed(1)} Hz`

/**
 * The tf tree's defects, over the edges read (the whole tf stream of a .db; windows across an .mcap, where `sampled`
 * says how far apart they are, so a stop or start is only known to within that). headerFrames: stream → the frame its
 * first message claims to be in.
 */
export function tfWarnings(
    edges: EdgeSpan[],
    start: number | null,
    end: number | null,
    headerFrames: Map<string, string>,
    sampledEvery = 0,
    sampledWindow = 0,
): Warning[] {
    const out: Warning[] = []
    if (!edges.length) {
        return out
    }
    const parentsOf = new Map<string, Set<string>>()
    const frames = new Set<string>()
    for (const edge of edges) {
        frames.add(edge.parent)
        frames.add(edge.child)
        parentsOf.set(edge.child, (parentsOf.get(edge.child) ?? new Set()).add(edge.parent))
    }
    for (const [child, parents] of parentsOf) {
        if (parents.size > 1) {
            out.push({
                kind: "two parents",
                message: `TF: "${child}" has ${parents.size} parents`,
                detail: `${[...parents].join(", ")} — tf allows one, so its pose flips between them`,
                frame: child,
            })
        }
    }
    const inCycle = new Set<string>()
    for (const frame of frames) {
        let at = frame
        const seen = new Set([frame])
        for (let step = 0; step <= frames.size; step++) {
            const parents = parentsOf.get(at)
            if (!parents?.size) {
                break
            }
            at = [...parents][0]
            if (seen.has(at)) {
                if (!inCycle.has(at)) {
                    for (const member of seen) {
                        inCycle.add(member)
                    }
                    out.push({
                        kind: "cycle",
                        message: `TF: a cycle through "${at}"`,
                        detail: `"${frame}" is its own ancestor`,
                        frame: at,
                    })
                }
                break
            }
            seen.add(at)
        }
    }
    const roots = [...frames].filter((frame) => !parentsOf.has(frame)).sort()
    if (roots.length > 1) {
        const sizes = roots.map((root) => `${root} (${subtreeSize(root, edges)})`)
        out.push({
            kind: "forest",
            message: `TF: ${roots.length} separate trees`,
            detail: `roots ${sizes.join(", ")} — frames in different trees can't be placed relative to each other`,
        })
    }
    const unplaced = new Map<string, string[]>()
    for (const [stream, frame] of headerFrames) {
        if (frame && !frames.has(frame)) {
            unplaced.set(frame, [...(unplaced.get(frame) ?? []), stream])
        }
    }
    if (unplaced.size) {
        const [[frame, streams]] = unplaced
        out.push({
            kind: "unplaced",
            message: unplaced.size === 1
                ? `TF: "${frame}" is not in the tree`
                : `TF: ${unplaced.size} frames streams are in aren't in the tree`,
            detail: unplaced.size === 1
                ? `${streams.join(", ")} ${streams.length === 1 ? "is" : "are"} in it, but tf never publishes it, so ` +
                    `nothing can place ${streams.length === 1 ? "that stream" : "those streams"}`
                : [...unplaced].map(([f, names]) =>
                    f === names[0] && names.length === 1 ? f : `${f} (${names.join(", ")})`
                )
                    .join(", ") + " — tf never publishes them, so nothing can place those streams",
            stream: streams[0],
            frame,
        })
    }
    const span = start !== null && end !== null ? end - start : 0
    const stops: EdgeSpan[] = []
    const lates: EdgeSpan[] = []
    for (const edge of edges) {
        if (edge.static) {
            continue
        }
        if (edge.count === 1 && !sampledEvery) {
            out.push({
                kind: "published once",
                message: `TF: ${edge.parent} → ${edge.child} is published once`,
                detail: `on a dynamic stream, at ${
                    offset(edge.first - (start ?? edge.first))
                } — was it meant to be static?`,
                frame: edge.child,
                at: edge.first - (start ?? edge.first),
            })
            continue
        }
        // read in windows, an edge too slow to show up in each one can't be said to stop or start
        if (span <= 0 || start === null || end === null || (sampledWindow && edge.hz * sampledWindow < 3)) {
            continue
        }
        // an edge runs at its own rate: ten missed turns and at least a second (or the sampling's spacing) is a stop
        const tolerance = Math.max(edge.hz > 0 ? 10 / edge.hz : 1, 1, sampledEvery * 1.5)
        if (end - edge.last > tolerance) {
            stops.push(edge)
        }
        if (edge.first - start > tolerance) {
            lates.push(edge)
        }
    }
    // edges that stop (or start) together are one publisher: one warning for them
    const names = (group: EdgeSpan[]) => {
        const shown = group.slice(0, 4).map((edge) => `${edge.parent} → ${edge.child}`).join(", ")
        return group.length > 4 ? `${shown}, +${group.length - 4} more` : shown
    }
    const sampled = sampledEvery ? ` (sampled every ${seconds(sampledEvery)})` : ""
    for (const group of together(stops, (edge) => edge.last)) {
        const last = Math.max(...group.map((edge) => edge.last))
        out.push({
            kind: "stops early",
            message: group.length === 1
                ? `TF: ${group[0].parent} → ${group[0].child} stops ${seconds(end! - last)} before the end`
                : `TF: ${group.length} transforms stop ${seconds(end! - last)} before the end`,
            detail: `${group.length === 1 ? "" : names(group) + " · "}last at ${offset(last - start!)}${sampled}` +
                (group.length === 1 && group[0].hz > 0 ? ` · it ran at ${hz(group[0].hz)}` : ""),
            frame: group[0].child,
            at: last - start!,
        })
    }
    for (const group of together(lates, (edge) => edge.first)) {
        const first = Math.min(...group.map((edge) => edge.first))
        out.push({
            kind: "starts late",
            message: group.length === 1
                ? `TF: ${group[0].parent} → ${group[0].child} starts ${seconds(first - start!)} in`
                : `TF: ${group.length} transforms start ${seconds(first - start!)} in`,
            detail: `${group.length === 1 ? "" : names(group) + " · "}first at ${offset(first - start!)}${sampled}`,
            frame: group[0].child,
            at: first - start!,
        })
    }
    return out
}

/** clusters of edges each within 2 s of the next (stopping together: one publisher) */
function together(edges: EdgeSpan[], time: (edge: EdgeSpan) => number): EdgeSpan[][] {
    const sorted = [...edges].sort((a, b) => time(a) - time(b))
    const groups: EdgeSpan[][] = []
    for (const edge of sorted) {
        const group = groups[groups.length - 1]
        const previous = group?.[group.length - 1]
        if (previous && time(edge) - time(previous) <= 2) {
            group.push(edge)
        } else {
            groups.push([edge])
        }
    }
    return groups
}

function subtreeSize(root: string, edges: EdgeSpan[]): number {
    const children = new Map<string, string[]>()
    for (const { parent, child } of edges) {
        children.set(parent, [...(children.get(parent) ?? []), child])
    }
    const seen = new Set<string>()
    const stack = [root]
    while (stack.length) {
        const frame = stack.pop()!
        if (seen.has(frame)) {
            continue
        }
        seen.add(frame)
        stack.push(...(children.get(frame) ?? []))
    }
    return seen.size
}

const median = (sorted: Float64Array | number[]) => sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0

/**
 * One stream's timing against itself and the recording. A late start / early stop is judged against when most streams
 * start and stop (`usualStart`, `usualEnd`: their medians), so one stream that runs on past the rest doesn't make every
 * other one "stop early". A gap is an outlier when it's past max(1 s, 10× the median
 * interval, median + 6 MADs). A stream silent in such gaps for over 20% of its span is published on demand (a
 * command, a goal), not broken: it says nothing.
 */
export function streamWarnings(
    name: string,
    times: number[],
    start: number | null,
    end: number | null,
    usualStart = start,
    usualEnd = end,
    multiplexed = false,
): Warning[] {
    const out: Warning[] = []
    if (times.length < 20 || start === null || end === null || /_static$/.test(name)) {
        return out
    }
    const intervals = new Float64Array(times.length - 1)
    for (let i = 1; i < times.length; i++) {
        intervals[i - 1] = times[i] - times[i - 1]
    }
    const sorted = intervals.slice().sort()
    const typical = median(sorted)
    if (!(typical > 0)) {
        return out
    }
    const deviations = sorted.map((value) => Math.abs(value - typical)).sort()
    const mad = median(deviations) * 1.4826
    const threshold = Math.max(1, 10 * typical, typical + 6 * mad)
    const gaps: { at: number; length: number }[] = []
    for (let i = 0; i < intervals.length; i++) {
        if (intervals[i] > threshold) {
            gaps.push({ at: times[i] - start, length: intervals[i] })
        }
    }
    const silent = gaps.reduce((sum, g) => sum + g.length, 0)
    const active = times[times.length - 1] - times[0]
    if (gaps.length >= 3 && silent > active * 0.2) {
        return out // published on demand (a command, a goal): its silences and its start and stop are its own
    }
    const usual = `usually every ${seconds(typical)} (${hz(1 / typical)})`
    if (gaps.length) {
        const worst = [...gaps].sort((a, b) => b.length - a.length)
        const shown = worst.slice(0, 3).sort((a, b) => a.at - b.at)
        out.push({
            kind: "gap",
            message: gaps.length === 1
                ? `${name}: a ${seconds(worst[0].length)} gap`
                : `${name}: ${gaps.length} gaps, longest ${seconds(worst[0].length)}`,
            detail: `${shown.map((g) => `${seconds(g.length)} at ${offset(g.at)}`).join(", ")}` +
                `${gaps.length > shown.length ? ", …" : ""} · ${usual}`,
            stream: name,
            at: worst[0].at,
        })
    }
    // a sag the gaps don't explain: windows whose own median interval is over twice the stream's (not tf's: it's many
    // publishers on one stream, its rate rises and falls with them, and its edges are judged one by one above)
    if (!multiplexed) {
        const window = Math.max(5, 50 * typical)
        let runStart: number | null = null
        let runEnd = 0
        let runIntervals: number[] = []
        let best: { from: number; to: number; rate: number } | null = null
        const close = () => {
            if (runStart !== null && runEnd - runStart >= 2 * window) {
                const rate = 1 / median(runIntervals.sort((a, b) => a - b))
                if (!best || runEnd - runStart > best.to - best.from) {
                    best = { from: runStart, to: runEnd, rate }
                }
            }
            runStart = null
            runIntervals = []
        }
        let i = 0
        for (let from = times[0]; from < times[times.length - 1]; from += window) {
            const inWindow: number[] = []
            while (i < intervals.length && times[i + 1] <= from + window) {
                if (times[i] >= from && intervals[i] <= threshold) {
                    inWindow.push(intervals[i])
                }
                i++
            }
            const slow = inWindow.length >= 3 && median(inWindow.sort((a, b) => a - b)) > 2 * typical
            if (slow) {
                runStart ??= from
                runEnd = from + window
                runIntervals.push(...inWindow)
            } else {
                close()
            }
        }
        close()
        if (best) {
            const { from, to, rate } = best as { from: number; to: number; rate: number }
            out.push({
                kind: "rate drop",
                message: `${name}: rate drops to ${hz(rate)} for ${seconds(to - from)}`,
                detail: `from ${offset(from - start)} · usually ${hz(1 / typical)}`,
                stream: name,
                at: from - start,
            })
        }
    }
    const span = end - start
    const tolerance = Math.max(5, 10 * typical, span * 0.05)
    const first = times[0]
    const last = times[times.length - 1]
    if (first - (usualStart ?? start) > tolerance) {
        out.push({
            kind: "starts late",
            message: `${name}: starts ${seconds(first - start)} in`,
            detail: `first message at ${offset(first - start)} of ${offset(span).slice(1)}`,
            stream: name,
            at: first - start,
        })
    }
    if ((usualEnd ?? end) - last > tolerance) {
        out.push({
            kind: "stops early",
            message: `${name}: stops ${seconds(end - last)} before the end`,
            detail: `last message at ${offset(last - start)} of ${offset(span).slice(1)}`,
            stream: name,
            at: last - start,
        })
    }
    return out
}

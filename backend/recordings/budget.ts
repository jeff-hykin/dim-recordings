// How a fixed number of message times (or index entries) is split between a recording's streams, and which parts of
// a stream too big for its share are read: windows at its start, its end and evenly between. Nothing that reads a
// recording holds more than its budget, however big the file.

/** Each count gets all it has while that fits; what's left goes equally to the bigger ones. */
export function shares(counts: number[], budget: number): number[] {
    const order = counts.map((_, i) => i).sort((a, b) => counts[a] - counts[b])
    const out = new Array<number>(counts.length).fill(0)
    let left = budget
    for (const [k, i] of order.entries()) {
        const share = Math.floor(left / (order.length - k))
        out[i] = Math.max(0, Math.min(counts[i], share))
        left -= out[i]
    }
    return out
}

/** `windows` runs of consecutive items, `keep` items in all, spread over [0, count): the first starts at 0 and the
 * last ends at count. Each is [first, length]; one window of everything when it fits. */
export function windowsOf(count: number, keep: number, windows = 16): [number, number][] {
    if (count <= keep) {
        return count > 0 ? [[0, count]] : []
    }
    const n = Math.max(1, Math.min(windows, keep))
    const length = Math.max(1, Math.floor(keep / n))
    if (n === 1) {
        return [[0, length]]
    }
    const out: [number, number][] = []
    for (let i = 0; i < n; i++) {
        const first = Math.round((count - length) * i / (n - 1))
        out.push([first, length])
    }
    return out
}

/** Sorts each run between NaN separators in place (a window of times is sorted; the windows stay apart). */
export function sortRuns(times: Float64Array): Float64Array {
    let from = 0
    for (let i = 0; i <= times.length; i++) {
        if (i === times.length || Number.isNaN(times[i])) {
            times.subarray(from, i).sort()
            from = i + 1
        }
    }
    return times
}

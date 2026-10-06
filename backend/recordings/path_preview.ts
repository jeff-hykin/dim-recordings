// The preview of a recording with no camera: its odometry path seen from above. The path comes from (first that has
// one) a nav_msgs/Path (lite_record's /pointlio_path is the whole trajectory in one message), the busiest odometry /
// pose stream, or tf's world/map/odom → body edge; it's thinned to a few hundred points and fitted into a unit box,
// and the page draws it as an SVG in the theme's colors (ui.tsx PathThumbnail).
import { decodeObject } from "../replay/payload.ts"
import { openSource, type Source, type StreamMeta } from "../replay/source.ts"

export type PathPreview = {
    /** the stream it came from */
    stream: string
    /** x, y fitted into [0, 1] (the longer side spans it, the other is centered), y up */
    points: [number, number][]
    /** the path's extent in metres (x, y) and its length */
    width: number
    height: number
    length: number
}

/** Most points kept for the drawing (the list carries them, so they stay few). */
export const MAX_POINTS = 240
/** Most messages read from a pose or tf stream. */
const MAX_SAMPLES = 600
/** A path smaller than this (metres, its longer side) is a rig that sat still: nothing worth drawing. */
export const MIN_EXTENT = 0.2
const WORLD_FRAMES = new Set(["world", "map", "odom"])

// deno-lint-ignore no-explicit-any
type Any = any

function xyOf(position: Any): [number, number] | null {
    const x = Number(position?.x)
    const y = Number(position?.y)
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null
}

/** Evenly spread indexes over [0, count), at most `most` of them, always the first and last. */
export function spread(count: number, most: number): number[] {
    if (count <= most) {
        return [...Array(count).keys()]
    }
    return [...Array(most).keys()].map((i) => Math.round((i * (count - 1)) / (most - 1)))
}

/** Thins a path to `most` points, fits it into a unit box (equal aspect) and measures it; null under two points. */
export function fitPath(stream: string, raw: [number, number][], most = MAX_POINTS): PathPreview | null {
    const points = raw.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
    if (points.length < 2) {
        return null
    }
    let length = 0
    for (let i = 1; i < points.length; i++) {
        length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
    }
    const xs = points.map((p) => p[0])
    const ys = points.map((p) => p[1])
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
    const width = maxX - minX
    const height = maxY - minY
    const side = Math.max(width, height) || 1
    const offsetX = (side - width) / 2
    const offsetY = (side - height) / 2
    const round = (value: number) => Math.round(value * 1000) / 1000
    const kept = spread(points.length, most).map((i) =>
        [round((points[i][0] - minX + offsetX) / side), round((points[i][1] - minY + offsetY) / side)] as [
            number,
            number,
        ]
    )
    return { stream, points: kept, width, height, length }
}

async function fromPath(source: Source, meta: StreamMeta): Promise<[number, number][]> {
    const { times } = await source.index(meta.name)
    if (!times.length) {
        return []
    }
    // the last message is the whole trajectory (a planner's Path is the latest plan, also fine to draw)
    const message = decodeObject(meta, await source.read(meta.name, times.length - 1))
    return ((message?.poses ?? []) as Any[]).map((pose) => xyOf(pose?.pose?.position)).filter((p) => p !== null)
}

async function fromPoses(source: Source, meta: StreamMeta): Promise<[number, number][]> {
    const { times } = await source.index(meta.name)
    const out: [number, number][] = []
    for (const i of spread(times.length, MAX_SAMPLES)) {
        const message = decodeObject(meta, await source.read(meta.name, i))
        // Odometry and PoseWithCovarianceStamped: pose.pose.position; PoseStamped: pose.position
        const xy = xyOf(message?.pose?.pose?.position ?? message?.pose?.position)
        if (xy) {
            out.push(xy)
        }
    }
    return out
}

/** The moving world → body edge of a tf stream: the child of world/map/odom whose translation moves the most. */
async function fromTf(source: Source, meta: StreamMeta): Promise<[number, number][]> {
    const { times } = await source.index(meta.name)
    const byChild = new Map<string, [number, number][]>()
    for (const i of spread(times.length, MAX_SAMPLES)) {
        const message = decodeObject(meta, await source.read(meta.name, i))
        for (const transform of (message?.transforms ?? []) as Any[]) {
            const parent = String(transform?.header?.frame_id ?? "").replace(/^\//, "")
            if (!WORLD_FRAMES.has(parent)) {
                continue
            }
            const xy = xyOf(transform?.transform?.translation)
            if (xy) {
                const child = `${parent}→${String(transform.child_frame_id ?? "").replace(/^\//, "")}`
                byChild.set(child, [...(byChild.get(child) ?? []), xy])
            }
        }
    }
    let best: [number, number][] = []
    let bestSpan = 0
    for (const points of byChild.values()) {
        const xs = points.map((p) => p[0])
        const ys = points.map((p) => p[1])
        const span = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
        if (span > bestSpan) {
            best = points
            bestSpan = span
        }
    }
    return bestSpan > 0.05 ? best : []
}

/** The recording's path from above, or null when it has no odometry, pose, Path or moving tf. */
export async function pathPreview(path: string): Promise<PathPreview | null> {
    const source = await openSource(path)
    try {
        const streams = source.streams.filter((s) => s.count > 0)
        const paths = streams.filter((s) => /(^|\.)Path$/.test(s.type))
        const poses = streams.filter((s) => s.kind === "pose")
            .sort((a, b) => Number(/Odometry$/.test(b.type)) - Number(/Odometry$/.test(a.type)) || b.count - a.count)
        const tf = streams.filter((s) => s.kind === "tf").sort((a, b) => b.count - a.count)
        type Reader = (source: Source, meta: StreamMeta) => Promise<[number, number][]>
        const attempts: [StreamMeta, Reader][] = [
            ...paths.map((meta): [StreamMeta, Reader] => [meta, fromPath]),
            ...poses.map((meta): [StreamMeta, Reader] => [meta, fromPoses]),
            ...tf.map((meta): [StreamMeta, Reader] => [meta, fromTf]),
        ]
        for (const [meta, read] of attempts) {
            try {
                const fitted = fitPath(meta.name.replace(/^\//, ""), await read(source, meta))
                if (fitted && Math.max(fitted.width, fitted.height) >= MIN_EXTENT) {
                    return fitted
                }
            } catch {
                // an undecodable stream: try the next
            }
        }
        return null
    } finally {
        source.close()
    }
}

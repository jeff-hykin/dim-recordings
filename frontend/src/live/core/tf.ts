// The transform tree from tf / tf_static. Everything drawn is placed by looking its header's frame_id up here,
// relative to the fixed frame the view is in; a frame with no path to it is reported, never drawn at the origin.
import { Matrix4, Quaternion, Vector3 } from "three"
import { Store } from "./store.ts"

interface Edge {
    parent: string
    /** T_parent_child */
    matrix: Matrix4
    isStatic: boolean
    receivedAt: number
}

export interface TfProblems {
    /** child -> the parents it has been given */
    doubleParent: [string, string[]][]
    /** more than one root means a forest: frames in different trees can't be related */
    roots: string[]
    /** frames on a cycle (unreachable from any root) */
    cycle: string[]
    /** dynamic edges that stopped arriving (child names) */
    stale: string[]
}

export interface TfSnapshot {
    frames: string[]
    edges: { parent: string; child: string; isStatic: boolean; ageMs: number }[]
    problems: TfProblems
}

/** A dynamic edge older than this is "stale" (tf_static is exempt: it publishes rarely). */
const STALE_MS = 2000
/** Frames commonly used as the world, in preference order, when picking a default fixed frame. */
const WORLD_NAMES = ["world", "map", "odom"]

const scratchVector = new Vector3()
const scratchQuaternion = new Quaternion()
const unitScale = new Vector3(1, 1, 1)

export class TfTree {
    /** what "now" is for staleness: the Replayer sets the playhead (ms), so a paused tree never goes stale */
    static clock = () => performance.now()
    #edges = new Map<string, Edge>()
    #parentsSeen = new Map<string, Set<string>>()
    #cache = new Map<string, Matrix4 | null>()
    #cacheFixed = ""
    /** bumped on every change, so layers know when to re-place what they drew */
    version = 0
    /** a summary for the UI, refreshed by `snapshot()` */
    readonly summary = new Store<
        { frames: number; problems: number; fixedFrame: string }
    >({ frames: 0, problems: 0, fixedFrame: "" })

    set(
        parent: string,
        child: string,
        translation: [number, number, number],
        rotation: [number, number, number, number],
        isStatic: boolean,
    ) {
        if (!parent || !child || parent === child) {
            return
        }
        let edge = this.#edges.get(child)
        if (!edge) {
            edge = { parent, matrix: new Matrix4(), isStatic, receivedAt: 0 }
            this.#edges.set(child, edge)
        }
        edge.parent = parent
        edge.isStatic = isStatic || edge.isStatic
        edge.receivedAt = TfTree.clock()
        edge.matrix.compose(
            scratchVector.set(...translation),
            scratchQuaternion.set(...rotation),
            unitScale,
        )
        let parents = this.#parentsSeen.get(child)
        if (!parents) {
            parents = new Set()
            this.#parentsSeen.set(child, parents)
        }
        parents.add(parent)
        this.#cache.clear()
        this.version++
    }

    has(frame: string): boolean {
        return this.#edges.has(frame) ||
            [...this.#edges.values()].some((edge) => edge.parent === frame)
    }

    /** The root above `frame` and T_root_frame, or null on a cycle. */
    #toRoot(frame: string): { root: string; matrix: Matrix4 } | null {
        const matrix = new Matrix4()
        let current = frame
        for (let guard = 0; guard < 128; guard++) {
            const edge = this.#edges.get(current)
            if (!edge) {
                return { root: current, matrix }
            }
            matrix.premultiply(edge.matrix)
            current = edge.parent
        }
        return null
    }

    /**
     * T_fixed_frame: places data in `frame` into the fixed frame. An empty frame or the fixed frame itself is
     * identity; null when there is no path (different trees, unknown frame, a cycle).
     */
    lookup(frame: string, fixed: string): Matrix4 | null {
        if (fixed !== this.#cacheFixed) {
            this.#cache.clear()
            this.#cacheFixed = fixed
        }
        const cached = this.#cache.get(frame)
        if (cached !== undefined) {
            return cached
        }
        let result: Matrix4 | null = null
        if (frame === fixed || frame === "") {
            result = new Matrix4()
        } else {
            const from = this.#toRoot(frame)
            const to = this.#toRoot(fixed)
            if (from && to && from.root === to.root) {
                result = to.matrix.clone().invert().multiply(from.matrix)
            } else if (
                from && !this.has(fixed) && from.root === frame &&
                WORLD_NAMES.includes(frame) && WORLD_NAMES.includes(fixed)
            ) {
                // no tf at all for either world-ish name (e.g. a map in "world" while nothing publishes tf): same frame
                result = new Matrix4()
            }
        }
        this.#cache.set(frame, result)
        return result
    }

    /** The fixed frame to default to: a world-ish root if there is one, else the root of the biggest tree. */
    defaultFixedFrame(): string {
        const roots = this.#roots()
        for (const name of WORLD_NAMES) {
            if (roots.includes(name)) {
                return name
            }
        }
        for (const name of WORLD_NAMES) {
            if (this.has(name)) {
                return name
            }
        }
        let best = roots[0] ?? "world"
        let bestSize = -1
        for (const root of roots) {
            const size = [...this.#edges.keys()].filter((child) => this.#toRoot(child)?.root === root).length
            if (size > bestSize) {
                best = root
                bestSize = size
            }
        }
        return best
    }

    #roots(): string[] {
        const roots = new Set<string>()
        for (const edge of this.#edges.values()) {
            if (!this.#edges.has(edge.parent)) {
                roots.add(edge.parent)
            }
        }
        return [...roots].sort()
    }

    snapshot(fixedFrame: string): TfSnapshot {
        const now = TfTree.clock()
        const frames = new Set<string>()
        const edges = []
        for (const [child, edge] of this.#edges) {
            frames.add(child)
            frames.add(edge.parent)
            edges.push({
                parent: edge.parent,
                child,
                isStatic: edge.isStatic,
                ageMs: Math.max(0, now - edge.receivedAt),
            })
        }
        const problems: TfProblems = {
            doubleParent: [...this.#parentsSeen].filter(([, parents]) => parents.size > 1).map((
                [child, parents],
            ) => [child, [...parents]]),
            roots: this.#roots(),
            cycle: [...this.#edges.keys()].filter((child) => this.#toRoot(child) === null),
            stale: edges.filter((edge) => !edge.isStatic && edge.ageMs > STALE_MS)
                .map((edge) => edge.child),
        }
        const count = problems.doubleParent.length +
            Math.max(0, problems.roots.length - 1) + problems.cycle.length +
            problems.stale.length
        const summary = this.summary.get()
        if (
            summary.frames !== frames.size || summary.problems !== count ||
            summary.fixedFrame !== fixedFrame
        ) {
            this.summary.set({ frames: frames.size, problems: count, fixedFrame })
        }
        return { frames: [...frames].sort(), edges, problems }
    }
}

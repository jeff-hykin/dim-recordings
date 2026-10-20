// TEMPORARY (until dimos's gateway previews .mcap uploads itself, dimos PR 4614): the console's spatial preview for an
// uploaded .mcap, built here and sent to the cloud (PUT /v1/data/uploads/{id}/preview). A port of dimos
// dimos/cloud/preview.py build() (format dimos-spatial-preview-v2) without the timelapse. Every step fails silently: no
// preview is the worst outcome, never a broken upload.
import { join } from "node:path"
import { decodeCloud, decodeObject } from "../replay/payload.ts"
import { atOrBefore, openSource, type Source, type StreamMeta } from "../replay/source.ts"
import { decodeCdrImage, type DecodedImage, decodeLcmCompressedImage, decodeLcmImage } from "./messages.ts"
import { compressedSize, ffmpeg, imageClass, writeFrame } from "./thumbnails.ts"
import type { Config } from "../config.ts"

// dimos/cloud/constants.py
const PREVIEW_FORMAT = "dimos-spatial-preview-v2"
const PREVIEW_SCALE = 0.02
const PREVIEW_FRAMES = 24
const PREVIEW_MAP_SCANS = 300
const PREVIEW_MAP_VOXEL = 0.1
const PREVIEW_MAP_POINTS = 40_000
const PREVIEW_SCAN_POINTS = 4_000
const PREVIEW_JOY_SAMPLES = 1500
const PREVIEW_BAND = [-0.5, 2.0]
const WORLD_FRAMES = ["world", "map", "odom"]
/** the server refuses a preview over 4 MB */
const PREVIEW_MAX_BYTES = 4 * 1024 * 1024 - 64 * 1024
/** bounds on what one preview decodes, so a long recording stays a few minutes of background work */
const MAX_POSES = 20_000
const MAX_TF_MESSAGES = 20_000
const MAX_CLOUD_POINTS = 200_000

// deno-lint-ignore no-explicit-any
type Any = any
type Vec3 = [number, number, number]
type Quat = [number, number, number, number]
type Rigid = { t: Vec3; q: Quat }
type Pose = { x: number; y: number; z: number; yaw: number }

const breathe = () => new Promise((resolve) => setTimeout(resolve, 0))
const frameName = (name: unknown) => String(name ?? "").replace(/^\//, "")

/** Evenly spread indexes over [0, n), at most k (numpy linspace(0, n-1, min(n, k)).astype(int)). */
function evenly(n: number, k: number): Set<number> {
    const m = Math.min(n, k)
    if (m <= 0) {
        return new Set()
    }
    if (m === 1) {
        return new Set([0])
    }
    return new Set([...Array(m).keys()].map((i) => Math.floor((i * (n - 1)) / (m - 1))))
}

// ── rigid transforms ──

function rotate(q: Quat, v: Vec3): Vec3 {
    const [x, y, z, w] = q
    const [vx, vy, vz] = v
    // v + 2w(q×v) + 2q×(q×v)
    const cx = y * vz - z * vy, cy = z * vx - x * vz, cz = x * vy - y * vx
    const dx = y * cz - z * cy, dy = z * cx - x * cz, dz = x * cy - y * cx
    return [vx + 2 * (w * cx + dx), vy + 2 * (w * cy + dy), vz + 2 * (w * cz + dz)]
}

/** a ∘ b: b's frame → a's target */
function compose(a: Rigid, b: Rigid): Rigid {
    const [ax, ay, az, aw] = a.q
    const [bx, by, bz, bw] = b.q
    const q: Quat = [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ]
    const r = rotate(a.q, b.t)
    return { t: [a.t[0] + r[0], a.t[1] + r[1], a.t[2] + r[2]], q }
}

function invert(a: Rigid): Rigid {
    const q: Quat = [-a.q[0], -a.q[1], -a.q[2], a.q[3]]
    const r = rotate(q, a.t)
    return { t: [-r[0], -r[1], -r[2]], q }
}

function rigidOf(translation: Any, rotation: Any): Rigid | null {
    const t: Vec3 = [Number(translation?.x), Number(translation?.y), Number(translation?.z)]
    const q: Quat = [Number(rotation?.x), Number(rotation?.y), Number(rotation?.z), Number(rotation?.w)]
    if (![...t, ...q].every(Number.isFinite)) {
        return null
    }
    const norm = Math.hypot(...q)
    return norm > 0 ? { t, q: q.map((v) => v / norm) as Quat } : null
}

function yawOf(q: Any): number {
    const [x, y, z, w] = [Number(q?.x ?? 0), Number(q?.y ?? 0), Number(q?.z ?? 0), Number(q?.w ?? 1)]
    const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
    return Number.isFinite(yaw) ? yaw : 0
}

/** The recording's tf: /tf samples (nearest in time) and /tf_static edges (always valid), searched both ways. */
class Tf {
    #dynamic = new Map<string, { times: number[]; values: Rigid[] }>()
    #static = new Map<string, Rigid>()
    #neighbors = new Map<string, Set<string>>()
    #times = new Map<string, Float64Array>()

    static async load(source: Source): Promise<Tf> {
        const tf = new Tf()
        for (const meta of source.streams.filter((s) => s.kind === "tf" && s.count > 0)) {
            try {
                const isStatic = /static/i.test(meta.name)
                const { times } = await source.index(meta.name)
                for (const i of evenly(times.length, isStatic ? 1000 : MAX_TF_MESSAGES)) {
                    const message = decodeObject(meta, await source.read(meta.name, i))
                    for (const transform of (message?.transforms ?? []) as Any[]) {
                        const parent = frameName(transform?.header?.frame_id)
                        const child = frameName(transform?.child_frame_id)
                        const rigid = rigidOf(transform?.transform?.translation, transform?.transform?.rotation)
                        if (parent && child && rigid) {
                            tf.#add(parent, child, isStatic ? null : times[i], rigid)
                        }
                    }
                    if (i % 200 === 0) {
                        await breathe()
                    }
                }
            } catch {
                // an undecodable tf stream: the others still count
            }
        }
        for (const samples of tf.#dynamic.values()) {
            const order = samples.times.map((_, i) => i).sort((a, b) => samples.times[a] - samples.times[b])
            samples.times = order.map((i) => samples.times[i])
            samples.values = order.map((i) => samples.values[i])
        }
        return tf
    }

    get empty() {
        return this.#neighbors.size === 0
    }

    #add(parent: string, child: string, time: number | null, rigid: Rigid) {
        const key = `${parent}\n${child}`
        if (time === null) {
            this.#static.set(key, rigid)
        } else {
            const samples = this.#dynamic.get(key) ?? { times: [], values: [] }
            samples.times.push(time)
            samples.values.push(rigid)
            this.#dynamic.set(key, samples)
        }
        for (const [a, b] of [[parent, child], [child, parent]]) {
            const set = this.#neighbors.get(a) ?? new Set()
            set.add(b)
            this.#neighbors.set(a, set)
        }
    }

    /** parent ← child at `time` */
    #edge(parent: string, child: string, time: number): Rigid | null {
        const key = `${parent}\n${child}`
        const fixed = this.#static.get(key)
        if (fixed) {
            return fixed
        }
        const samples = this.#dynamic.get(key)
        if (!samples?.times.length) {
            return null
        }
        let times = this.#times.get(key)
        if (!times) {
            times = Float64Array.from(samples.times)
            this.#times.set(key, times)
        }
        const before = atOrBefore(times, time)
        const after = Math.min(before + 1, samples.times.length - 1)
        const pick = before < 0 || Math.abs(samples.times[after] - time) < Math.abs(samples.times[before] - time)
            ? after
            : before
        return samples.values[pick]
    }

    /** target ← source at `time`, or null when tf doesn't connect them */
    get(target: string, source: string, time: number): Rigid | null {
        if (target === source) {
            return { t: [0, 0, 0], q: [0, 0, 0, 1] }
        }
        const previous = new Map<string, string>([[source, ""]])
        const queue = [source]
        while (queue.length && !previous.has(target)) {
            const frame = queue.shift()!
            for (const next of this.#neighbors.get(frame) ?? []) {
                if (!previous.has(next)) {
                    previous.set(next, frame)
                    queue.push(next)
                }
            }
        }
        if (!previous.has(target)) {
            return null
        }
        let total: Rigid = { t: [0, 0, 0], q: [0, 0, 0, 1] }
        for (let to = target; to !== source;) {
            const from = previous.get(to)!
            // to ← from: an edge one way, or the inverse of the edge the other way
            const step = this.#edge(to, from, time) ?? (() => {
                const back = this.#edge(from, to, time)
                return back ? invert(back) : null
            })()
            if (!step) {
                return null
            }
            total = compose(total, step)
            to = from
        }
        return total
    }

    /** the moving child of a world frame (the robot), for a recording with tf but no odometry stream */
    movingBody(): { frame: string; poses: [number, Pose][] } | null {
        let best: { frame: string; poses: [number, Pose][]; span: number } | null = null
        for (const [key, samples] of this.#dynamic) {
            const [parent] = key.split("\n")
            if (!WORLD_FRAMES.includes(parent)) {
                continue
            }
            const xs = samples.values.map((v) => v.t[0]), ys = samples.values.map((v) => v.t[1])
            const span = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
            if (span > (best?.span ?? 0.05)) {
                const poses = samples.times.map((time, i): [number, Pose] => {
                    const { t, q } = samples.values[i]
                    return [time, { x: t[0], y: t[1], z: t[2], yaw: yawOf({ x: q[0], y: q[1], z: q[2], w: q[3] }) }]
                })
                best = { frame: parent, poses, span }
            }
        }
        return best
    }
}

// ── point clouds as flat xyz ──

function transformed(points: Float32Array, rigid: Rigid): Float32Array {
    const out = new Float32Array(points.length)
    for (let i = 0; i < points.length; i += 3) {
        const r = rotate(rigid.q, [points[i], points[i + 1], points[i + 2]])
        out[i] = r[0] + rigid.t[0]
        out[i + 1] = r[1] + rigid.t[1]
        out[i + 2] = r[2] + rigid.t[2]
    }
    return out
}

/** One point per voxel (the first in it); `into` keeps a running map across scans. */
function voxelized(points: Float32Array, size: number, into = new Map<string, Vec3>()): Map<string, Vec3> {
    for (let i = 0; i < points.length; i += 3) {
        const key = `${Math.floor(points[i] / size)},${Math.floor(points[i + 1] / size)},${
            Math.floor(points[i + 2] / size)
        }`
        if (!into.has(key)) {
            into.set(key, [points[i], points[i + 1], points[i + 2]])
        }
    }
    return into
}

const flat = (voxels: Map<string, Vec3>) => Float32Array.from([...voxels.values()].flat())

function band(points: Float32Array, low: number, high: number): Float32Array {
    const out: number[] = []
    for (let i = 0; i < points.length; i += 3) {
        if (points[i + 2] >= low && points[i + 2] <= high) {
            out.push(points[i], points[i + 1], points[i + 2])
        }
    }
    return Float32Array.from(out)
}

/** coarser voxels until it fits */
function fit(points: Float32Array, most: number): Float32Array {
    const n = points.length / 3
    return n <= most ? points : flat(voxelized(points, PREVIEW_MAP_VOXEL * Math.sqrt(n / most)))
}

function base64(bytes: Uint8Array): string {
    let text = ""
    for (let i = 0; i < bytes.length; i += 0x8000) {
        text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    }
    return btoa(text)
}

/** little-endian int16 triplets of PREVIEW_SCALE around origin */
function pack(points: Float32Array, origin: number[]): string {
    const out = new Int16Array(points.length)
    for (let i = 0; i < points.length; i++) {
        out[i] = Math.max(-32767, Math.min(32767, Math.round((points[i] - origin[i % 3]) / PREVIEW_SCALE)))
    }
    return base64(new Uint8Array(out.buffer))
}

// ── streams ──

/** the busiest stream of a kind, ones named like `prefer` first (a mapper's global_map is a PointCloud2 too) */
function pick(source: Source, test: (meta: StreamMeta) => boolean, prefer: string): StreamMeta | null {
    const found = source.streams.filter((s) => s.count > 0 && test(s)).sort((a, b) =>
        Number(!a.name.includes(prefer)) - Number(!b.name.includes(prefer)) ||
        Number(/map/i.test(a.name)) - Number(/map/i.test(b.name)) ||
        b.count - a.count
    )
    return found[0] ?? null
}

function decodedImage(meta: StreamMeta, raw: Uint8Array): DecodedImage {
    const image = meta.encoding === "cdr"
        ? decodeCdrImage(meta.schemaName ?? "", meta.schemaText ?? "", raw)
        : /Compressed/.test(meta.type)
        ? decodeLcmCompressedImage(raw)
        : decodeLcmImage(raw)
    return image.compressed && !image.width ? { ...image, ...compressedSize(image.data) } : image
}

async function jpegOf(image: DecodedImage, folder: string, n: number): Promise<string | null> {
    try {
        const out = join(folder, `${n}.jpg`)
        await writeFrame(image, out)
        return base64(await Deno.readFile(out))
    } catch {
        return null
    }
}

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits

/** `dimos-spatial-preview-v2` for a recording, or null when it has no LiDAR, camera or poses. */
export async function buildPreview(path: string): Promise<Record<string, unknown> | null> {
    const source = await openSource(path)
    try {
        const lidar = pick(source, (s) => s.kind === "cloud", "lidar")
        const camera = pick(
            source,
            (s) => s.kind === "image" && imageClass(s.name, "") < 2,
            "color",
        )
        const odom = pick(source, (s) => s.kind === "pose", "odom")
        const joy = pick(source, (s) => /(^|\.)Joy$/.test(s.type), "joy")
        let tf: Tf | null = null
        try {
            tf = await Tf.load(source)
        } catch {
            tf = null
        }

        // the path: the odometry stream, else tf's moving body
        let poses: [number, Pose][] = []
        let frame = ""
        if (odom) {
            try {
                const { times } = await source.index(odom.name)
                for (const i of evenly(times.length, MAX_POSES)) {
                    const message = decodeObject(odom, await source.read(odom.name, i))
                    const pose = message?.pose?.pose ?? message?.pose ?? message
                    const [x, y, z] = [Number(pose?.position?.x), Number(pose?.position?.y), Number(pose?.position?.z)]
                    if ([x, y, z].every(Number.isFinite)) {
                        poses.push([times[i], { x, y, z, yaw: yawOf(pose?.orientation) }])
                        frame ||= frameName(message?.header?.frame_id)
                    }
                    if (i % 500 === 0) {
                        await breathe()
                    }
                }
            } catch {
                poses = []
            }
        }
        if (!poses.length && tf) {
            const body = tf.movingBody()
            if (body) {
                const kept = evenly(body.poses.length, MAX_POSES)
                poses = body.poses.filter((_, i) => kept.has(i))
                frame = body.frame
            }
        }
        // scans go in the path's frame, so the path lines up with the map
        const frames = frame ? [frame] : WORLD_FRAMES

        const ends: number[] = []
        const scans: [number, Float32Array][] = []
        let world: Map<string, Vec3> | null = null
        if (lidar) {
            try {
                const { times } = await source.index(lidar.name)
                if (times.length) {
                    ends.push(times[0], times[times.length - 1])
                }
                const shown = evenly(times.length, PREVIEW_FRAMES)
                const merged = [...new Set([...shown, ...evenly(times.length, PREVIEW_MAP_SCANS)])].sort((a, b) =>
                    a - b
                )
                for (const i of merged) {
                    await breathe()
                    try {
                        const cloud = decodeCloud(lidar, await source.read(lidar.name, i), MAX_CLOUD_POINTS)
                        if (!cloud || !cloud.positions.length) {
                            continue
                        }
                        let points = cloud.positions
                        const cloudFrame = frameName(cloud.frame)
                        if (!frames.includes(cloudFrame)) {
                            const placed = frames.map((f) => tf?.get(f, cloudFrame, times[i]) ?? null).find(Boolean)
                            if (placed) {
                                points = transformed(points, placed)
                            } else if (!WORLD_FRAMES.includes(cloudFrame)) {
                                continue // a sensor-frame scan tf can't place
                            }
                        }
                        const voxels = voxelized(points, PREVIEW_MAP_VOXEL)
                        if (shown.has(i)) {
                            scans.push([times[i], flat(voxels)])
                        }
                        world = world ?? new Map()
                        for (const [key, point] of voxels) {
                            if (!world.has(key)) {
                                world.set(key, point)
                            }
                        }
                    } catch {
                        // one bad scan: skip it
                    }
                }
            } catch {
                // no scans
            }
        }

        const sticks: [number, number[], number[]][] = []
        if (joy) {
            try {
                const { times } = await source.index(joy.name)
                for (const i of evenly(times.length, PREVIEW_JOY_SAMPLES)) {
                    const message = decodeObject(joy, await source.read(joy.name, i))
                    if (message) {
                        sticks.push([
                            times[i],
                            Array.from(message.axes ?? [], (a: number) => round(Number(a), 2)),
                            Array.from(message.buttons ?? [], Number),
                        ])
                    }
                }
            } catch {
                // no joystick
            }
        }

        const shots: [number, string][] = []
        if (camera && ffmpeg()) {
            const folder = await Deno.makeTempDir({ prefix: "dim-recordings-preview-" })
            try {
                const { times } = await source.index(camera.name)
                let n = 0
                for (const i of [...evenly(times.length, PREVIEW_FRAMES)].sort((a, b) => a - b)) {
                    try {
                        const jpeg = await jpegOf(decodedImage(camera, await source.read(camera.name, i)), folder, n++)
                        if (jpeg) {
                            shots.push([times[i], jpeg])
                        }
                    } catch {
                        // an undecodable frame
                    }
                }
            } catch {
                // no thumbnails
            } finally {
                await Deno.remove(folder, { recursive: true }).catch(() => {})
            }
        }

        if (poses.length) {
            ends.push(poses[0][0], poses[poses.length - 1][0])
        }
        if (shots.length) {
            ends.push(shots[0][0], shots[shots.length - 1][0])
        }
        if (!ends.length) {
            return null
        }

        const heights = poses.map(([, p]) => p.z).sort((a, b) => a - b)
        const z = heights.length ? (heights[(heights.length - 1) >> 1] + heights[heights.length >> 1]) / 2 : 0
        const [low, high] = [z + PREVIEW_BAND[0], z + PREVIEW_BAND[1]]
        const map = world ? fit(band(flat(world), low, high), PREVIEW_MAP_POINTS) : null
        const fittedScans = scans.map(([t, points]): [number, Float32Array] => [
            t,
            fit(band(points, low, high), PREVIEW_SCAN_POINTS),
        ])

        const t0 = Math.min(...ends), t1 = Math.max(...ends)
        const trajectory = [...evenly(poses.length, 3000)].sort((a, b) => a - b).map((i) => {
            const [t, p] = poses[i]
            return [t - t0, p.x, p.y, p.z, p.yaw].map((v) => round(v, 3))
        })
        let extent: number[][] = map?.length
            ? [...Array(map.length / 3).keys()].map((i) => [map[i * 3], map[i * 3 + 1], map[i * 3 + 2]])
            : trajectory.map((r) => r.slice(1, 4))
        if (!extent.length) {
            extent = [[0, 0, z]]
        }
        const axis = (k: number) => extent.map((p) => p[k])
        const origin = [0, 1, 2].map((k) => round(axis(k).reduce((a, b) => a + b, 0) / extent.length, 2))
        const bounds = [
            [0, 1, 2].map((k) => round(axis(k).reduce((a, b) => Math.min(a, b)), 2)),
            [0, 1, 2].map((k) => round(axis(k).reduce((a, b) => Math.max(a, b)), 2)),
        ]
        const streams: Record<string, { name: string; count: number }> = {}
        for (
            const [key, meta] of [["lidar", lidar], ["camera", camera], ["odom", lidar ? null : odom], [
                "joystick",
                joy,
            ]] as const
        ) {
            if (meta) {
                streams[key] = { name: meta.name.replaceAll("/", "_"), count: meta.count } // dimos's stream slug
            }
        }
        const doc: Record<string, Any> = {
            format: PREVIEW_FORMAT,
            duration_s: round(t1 - t0, 3),
            origin,
            scale: PREVIEW_SCALE,
            bounds,
            streams,
            trajectory,
            map: map ? pack(map, origin) : "",
            scans: fittedScans.map(([t, points]) => ({ t: round(t - t0, 3), points: pack(points, origin) })),
            camera: shots.map(([t, jpeg]) => ({ t: round(t - t0, 3), jpeg })),
            thumb: shots.length ? shots.length >> 1 : null,
            joy: sticks.map(([t, axes, buttons]) => [round(t - t0, 3), axes, buttons]),
        }
        // over the server's cap: thin the thumbnails, then the scans, then the joystick
        for (const field of ["camera", "scans", "joy"]) {
            while (new TextEncoder().encode(JSON.stringify(doc)).length > PREVIEW_MAX_BYTES && doc[field].length) {
                doc[field] = doc[field].filter((_: unknown, i: number) => i % 2 === 0).slice(0, -1)
                if (field === "camera") {
                    doc.thumb = doc.camera.length ? doc.camera.length >> 1 : null
                }
            }
        }
        return doc
    } finally {
        source.close()
    }
}

// ── sending it: after an .mcap upload finishes ──

/** The dimos cloud key: DIMOS_API_KEY, dimos's credentials file, else asked of a dimos python (it holds the keyring item;
 * macOS's `security` would pop a dialog). */
async function apiKey(): Promise<string | null> {
    const fromEnv = Deno.env.get("DIMOS_API_KEY")?.trim()
    if (fromEnv) {
        return fromEnv
    }
    const home = Deno.env.get("HOME") ?? ""
    const configDir = Deno.env.get("XDG_CONFIG_HOME") ?? join(home, ".config")
    for (
        const file of [
            join(configDir, "dimos", "credentials"),
            join(home, "Library", "Application Support", "dimos", "credentials"),
        ]
    ) {
        try {
            const key = (await Deno.readTextFile(file)).trim()
            if (key) {
                return key
            }
        } catch {
            // not there
        }
    }
    const dimosHome = Deno.env.get("DIMOS_HOME") ?? join(home, ".dimos")
    const pythons: string[] = []
    const explicit = Deno.env.get("DIMOS_PYTHON")
    if (explicit) {
        pythons.push(explicit)
    }
    try {
        // the running gateways' pythons, Desktop's own (its sockets live under DIMOS_HOME/desktop) first
        const { stdout } = await new Deno.Command("ps", {
            args: ["-axww", "-o", "command="],
            stdout: "piped",
            stderr: "null",
        })
            .output()
        const lines = new TextDecoder().decode(stdout).split("\n").filter((l) => / -m experimental\.gateway\b/.test(l))
        lines.sort((a, b) =>
            Number(!a.includes(join(dimosHome, "desktop"))) - Number(!b.includes(join(dimosHome, "desktop")))
        )
        for (const line of lines) {
            const program = line.trim().split(/\s+/)[0]
            if (/python/.test(program) && !pythons.includes(program)) {
                pythons.push(program)
            }
        }
    } catch {
        // no ps
    }
    for (const python of pythons) {
        try {
            const { success, stdout } = await new Deno.Command(python, {
                args: ["-c", "from dimos.cli import cloud; print(cloud.api_key() or '')"],
                stdout: "piped",
                stderr: "null",
                signal: AbortSignal.timeout(30_000),
            }).output()
            const key = new TextDecoder().decode(stdout).trim().split("\n").pop()?.trim()
            if (success && key) {
                return key
            }
        } catch {
            // the next one
        }
    }
    return null
}

type Attempt = { path: string; at: number; ok: boolean; tries: number; error?: string }
type State = { since: number; done: Record<string, Attempt> }
type Entry = { path: string; uploadId: string; uploadedAt?: number }

export class CloudPreviews {
    #state: State | null = null
    #queue: { entry: Entry; cloudUrl: string }[] = []
    #running = false
    #key: string | null = null

    constructor(public config: Config) {}

    get #file() {
        return join(this.config.dataDir, "cloud_previews.json")
    }

    async #load(): Promise<State> {
        if (!this.#state) {
            try {
                this.#state = JSON.parse(await Deno.readTextFile(this.#file)) as State
            } catch {
                // first run: only uploads from now on (earlier ones may already have dimos's preview, with its timelapse)
                this.#state = { since: Date.now(), done: {} }
                await this.#save()
            }
        }
        return this.#state
    }

    async #save() {
        try {
            await Deno.mkdir(this.config.dataDir, { recursive: true })
            await Deno.writeTextFile(this.#file, JSON.stringify(this.#state, null, 2))
        } catch {
            // the next look tries again
        }
    }

    /** finished uploads (the gateway's byPath entries): queue each new .mcap once (three tries) */
    async consider(entries: Entry[], cloudUrl?: string) {
        try {
            const state = await this.#load()
            for (const entry of entries) {
                const attempt = state.done[entry.uploadId]
                if (
                    !entry?.uploadId || !/\.mcap$/i.test(entry.path ?? "") || (entry.uploadedAt ?? 0) < state.since ||
                    attempt?.ok || (attempt?.tries ?? 0) >= 3 || this.#queue.some((q) =>
                        q.entry.uploadId === entry.uploadId
                    )
                ) {
                    continue
                }
                this.#queue.push({ entry, cloudUrl: cloudUrl || "" })
            }
            this.#work()
        } catch {
            // never in an upload's way
        }
    }

    /** builds and sends one now (api: an upload from before this existed); throws what went wrong */
    async force(entry: Entry, cloudUrl?: string) {
        await this.#load()
        await this.#send(entry, cloudUrl || "")
    }

    async #work() {
        if (this.#running) {
            return
        }
        this.#running = true
        try {
            while (this.#queue.length) {
                const { entry, cloudUrl } = this.#queue.shift()!
                await this.#send(entry, cloudUrl).catch(() => {})
            }
        } finally {
            this.#running = false
        }
    }

    async #send(entry: Entry, cloudUrl: string) {
        const state = await this.#load()
        const tries = (state.done[entry.uploadId]?.tries ?? 0) + 1
        try {
            const doc = await buildPreview(entry.path)
            if (!doc) {
                state.done[entry.uploadId] = {
                    path: entry.path,
                    at: Date.now(),
                    ok: true,
                    tries,
                    error: "nothing to preview",
                }
                return
            }
            this.#key ??= await apiKey()
            if (!this.#key) {
                throw new Error("no dimos cloud key")
            }
            const base = (cloudUrl || Deno.env.get("DIMOS_CLOUD_URL") || "https://api.dimensional.org").replace(
                /\/+$/,
                "",
            )
            const response = await fetch(`${base}/v1/data/uploads/${encodeURIComponent(entry.uploadId)}/preview`, {
                method: "PUT",
                headers: { "authorization": `Bearer ${this.#key}`, "content-type": "application/json" },
                body: JSON.stringify(doc),
                signal: AbortSignal.timeout(120_000),
            })
            const text = await response.text()
            if (response.status === 401) {
                this.#key = null
            }
            if (!response.ok) {
                throw new Error(`PUT preview: ${response.status} ${text.slice(0, 200)}`)
            }
            state.done[entry.uploadId] = { path: entry.path, at: Date.now(), ok: true, tries }
            console.error(`cloud preview sent for ${entry.path} (${entry.uploadId})`)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            state.done[entry.uploadId] = { path: entry.path, at: Date.now(), ok: false, tries, error: message }
            console.error(`no cloud preview for ${entry.path}: ${message}`)
            throw error
        } finally {
            await this.#save()
        }
    }
}

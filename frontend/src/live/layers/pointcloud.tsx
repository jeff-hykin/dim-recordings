// sensor_msgs.PointCloud2: lidar scans and maps. The bridge's dimos-pointcloud2 codec sends quantized xyz (+ u8
// intensity); the points go straight into preallocated GPU buffers (a ring when accumulating) and are colored in
// the shader, so a new scan costs one buffer upload and nothing is allocated per frame.
import * as THREE from "three"
import { type LayerContext, registerLayer } from "../core/layers/registry.ts"
import { placeInFixedFrame } from "../core/layers/helpers.ts"
import { headerFrameId } from "../core/lcm/lcm.ts"
import { applyLook, makePointMaterial, type PointLook } from "../core/render/pointMaterial.ts"
import type { Store } from "../core/store.ts"
import { mediaSeconds, type Topic } from "../core/transport.ts"
import { PointLookEditor } from "../ui/PointLookEditor.tsx"
import { rendering, resolveStyle, splatFallback } from "../core/render/rendering.ts"
import { Field, Select, Slider } from "../ui/controls.tsx"
import { useStore } from "../core/store.ts"

export interface CloudSettings {
    look: PointLook
    /** "latest": only the newest scan, moved by TF every frame; "accumulate": scans stay where they were seen */
    mode: "latest" | "accumulate"
    /** accumulate: forget points older than this (0 = never) */
    windowSeconds: number
    /** accumulate: ring capacity */
    maxPoints: number
    maxHz: number
    /** "full": every point; "auto": the bridge thins clouds when bandwidth is short */
    detail: "full" | "auto"
}

const isMap = (topic: Topic) => /map|global|voxel|terrain|costmap/i.test(topic.name)

const DEFAULTS: CloudSettings = {
    look: {
        style: "default",
        size: 0.04,
        colorMode: "height",
        gradient: "memworld",
        axis: 2,
        rangeMin: null,
        rangeMax: null,
        solid: "#7fd4ff",
        opacity: 1,
    },
    mode: "latest",
    windowSeconds: 10,
    maxPoints: 2_000_000,
    maxHz: 20,
    detail: "auto",
}

const SPLAT_BUDGET = 3_000_000

/** How often the cloud's frame_id is re-read from one raw message (the codec output carries no header). */
const FRAME_RECHECK_MS = 30_000

class CloudLayer {
    readonly root = new THREE.Group()
    #points: THREE.Points
    #geometry = new THREE.BufferGeometry()
    #material: THREE.ShaderMaterial
    #capacity = 0
    #write = 0
    #filled = 0
    #frame: string | null = null
    #range: [number, number] = [0, 2]
    #rangeSeen = false
    #unsubscribe: (() => void)[] = []
    #stopStream: (() => void) | null = null
    #streamOptions = ""
    #frameTimer: ReturnType<typeof setInterval>
    #fixedFrame = ""
    #lastCount = 0
    #rate = { count: 0, since: performance.now(), hz: 0 }
    #settings: Store<CloudSettings>
    #mode: CloudSettings["mode"]

    constructor(
        readonly context: LayerContext,
        readonly topic: Topic,
        settings: Store<CloudSettings>,
    ) {
        this.#settings = settings
        this.#mode = settings.get().mode
        this.#material = makePointMaterial(context.viewer.pixelsPerMeter)
        this.#points = new THREE.Points(this.#geometry, this.#material)
        this.#points.frustumCulled = false
        this.#points.matrixAutoUpdate = false
        this.root.add(this.#points)
        this.#resize(1024)
        this.#readFrame()
        this.#frameTimer = setInterval(() => this.#readFrame(), FRAME_RECHECK_MS)
        settings.subscribe(() => this.#onSettings())
        this.#unsubscribe.push(
            rendering.subscribe(() => this.#onSettings()),
            splatFallback.subscribe(() => this.#onSettings()),
        )
        this.#onSettings()
    }

    #onSettings() {
        const settings = this.#settings.get()
        if (settings.mode !== this.#mode) {
            this.#mode = settings.mode
            this.#clear()
        }
        if (`${settings.maxHz}/${settings.detail}` !== this.#streamOptions) {
            this.#streamOptions = `${settings.maxHz}/${settings.detail}`
            this.#subscribe()
        }
        this.#material.uniforms.uWindow.value = settings.mode === "accumulate" && settings.windowSeconds > 0
            ? settings.windowSeconds
            : -1
        applyLook(this.#material, this.#look(), this.#range)
        this.#syncSplatBudget()
        this.context.viewer.requestRender()
    }

    #subscribe() {
        const settings = this.#settings.get()
        this.#stopStream?.()
        this.#stopStream = this.context.connection.subscribe(
            this.topic.key,
            {
                delivery: "latest",
                maxHz: settings.maxHz,
                codec: "dimos-pointcloud2",
                ...(settings.detail === "full" ? { minQuality: 1 } : {}),
            },
            (message) => {
                const decoded = message.decoded as {
                    positions?: Float32Array
                    intensity?: Uint8Array
                } | undefined
                if (decoded?.positions) {
                    this.#onCloud(
                        decoded.positions,
                        decoded.intensity,
                        message.timestamp,
                    )
                }
            },
        )
    }

    /** One raw message for its header's frame_id, then unsubscribe (a raw cloud is big). */
    #readFrame() {
        let stop: (() => void) | null = null
        stop = this.context.connection.subscribe(this.topic.key, {
            delivery: "latest",
            maxHz: 1,
        }, (message) => {
            const frame = headerFrameId(this.topic.type, message.bytes)
            if (frame !== null && frame !== this.#frame) {
                this.#frame = frame
                this.#clear()
            }
            stop?.()
            stop = null
        })
        this.#unsubscribe.push(() => stop?.())
    }

    /** the look with "default" and the splat fallback resolved */
    #look(): PointLook {
        const look = this.#settings.get().look
        return { ...look, style: resolveStyle(look.style) }
    }

    /** Glow is fill-bound: over SPLAT_BUDGET points a stable random subset is drawn (see the vertex shader). */
    #syncSplatBudget() {
        this.#material.uniforms.uKeep.value = Math.min(
            1,
            SPLAT_BUDGET / Math.max(1, this.#filled),
        )
    }

    #resize(capacity: number) {
        this.#capacity = capacity
        const position = new THREE.BufferAttribute(
            new Float32Array(capacity * 3),
            3,
        ).setUsage(THREE.DynamicDrawUsage)
        const time = new THREE.BufferAttribute(new Float32Array(capacity), 1)
            .setUsage(THREE.DynamicDrawUsage)
        // u8 like the bridge sends it (the shader reads 0..255 as a float): 17 bytes a point with position and time
        const intensity = new THREE.BufferAttribute(new Uint8Array(capacity), 1)
            .setUsage(THREE.DynamicDrawUsage)
        this.#geometry.dispose()
        this.#geometry = new THREE.BufferGeometry()
        this.#geometry.setAttribute("position", position)
        this.#geometry.setAttribute("aTime", time)
        this.#geometry.setAttribute("aIntensity", intensity)
        this.#geometry.setDrawRange(0, 0)
        this.#points.geometry = this.#geometry
        this.#write = 0
        this.#filled = 0
    }

    #clear() {
        this.#write = 0
        this.#filled = 0
        this.#rangeSeen = false
        this.#geometry.setDrawRange(0, 0)
        this.context.viewer.requestRender()
    }

    #onCloud(
        positions: Float32Array,
        intensity: Uint8Array | undefined,
        timestamp: number,
    ) {
        if (this.#frame === null) {
            return // placed without its frame it would ride the wrong pose; the raw read arrives within a second
        }
        const settings = this.#settings.get()
        const count = positions.length / 3
        this.#lastCount = count
        this.#rate.count++
        const accumulate = settings.mode === "accumulate"
        let transform: THREE.Matrix4 | null = null
        if (accumulate) {
            transform = this.context.tf.lookup(
                this.#frame,
                this.context.viewer.fixedFrame,
            )
            if (!transform) {
                this.context.setStatus({
                    problem: `no TF path from "${this.#frame}" to "${this.context.viewer.fixedFrame}"`,
                })
                return
            }
        }
        const wanted = accumulate ? Math.max(count, settings.maxPoints) : count
        if (
            wanted > this.#capacity ||
            (!accumulate && this.#capacity > 4 * Math.max(wanted, 1024))
        ) {
            this.#resize(
                accumulate ? wanted : Math.max(1024, 2 ** Math.ceil(Math.log2(wanted))),
            )
        }
        const position = this.#geometry.getAttribute(
            "position",
        ) as THREE.BufferAttribute
        const time = this.#geometry.getAttribute("aTime") as THREE.BufferAttribute
        const strength = this.#geometry.getAttribute(
            "aIntensity",
        ) as THREE.BufferAttribute
        const now = mediaSeconds()
        const start = accumulate ? this.#write : 0
        const xyz = position.array as Float32Array
        const times = time.array as Float32Array
        const values = strength.array as Uint8Array
        const e = transform?.elements
        for (let index = 0; index < count; index++) {
            const slot = (start + index) % this.#capacity
            const x = positions[index * 3],
                y = positions[index * 3 + 1],
                z = positions[index * 3 + 2]
            if (e) {
                xyz[slot * 3] = e[0] * x + e[4] * y + e[8] * z + e[12]
                xyz[slot * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13]
                xyz[slot * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14]
            } else {
                xyz[slot * 3] = x
                xyz[slot * 3 + 1] = y
                xyz[slot * 3 + 2] = z
            }
            times[slot] = now
            values[slot] = intensity ? intensity[index] : 0
        }
        // upload only what changed (a wrapped write is two ranges)
        for (const attribute of [position, time, strength]) {
            attribute.clearUpdateRanges()
            const size = attribute.itemSize
            const firstLength = Math.min(count, this.#capacity - start)
            attribute.addUpdateRange(start * size, firstLength * size)
            if (firstLength < count) {
                attribute.addUpdateRange(0, (count - firstLength) * size)
            }
            attribute.needsUpdate = true
        }
        if (accumulate) {
            this.#write = (start + count) % this.#capacity
            this.#filled = Math.min(this.#capacity, this.#filled + count)
            this.#points.matrix.identity()
        } else {
            this.#filled = count
        }
        this.#geometry.setDrawRange(0, this.#filled)
        this.#syncSplatBudget()
        this.#updateRange(
            positions,
            intensity,
            transform ??
                this.context.tf.lookup(this.#frame, this.context.viewer.fixedFrame),
        )
        this.context.viewer.noteData(timestamp)
    }

    /** Auto color range: 5th-95th percentile (MemWorld's) of a sample, eased so it doesn't flicker scan to scan. */
    #updateRange(
        positions: Float32Array,
        intensity: Uint8Array | undefined,
        transform: THREE.Matrix4 | null,
    ) {
        const look = this.#settings.get().look
        const count = positions.length / 3
        if (!count) {
            return
        }
        let low: number, high: number
        if (look.colorMode === "intensity") {
            ;[low, high] = intensity ? [0, 255] : [0, 1]
        } else {
            const e = transform?.elements ?? new THREE.Matrix4().elements
            const step = Math.max(1, Math.floor(count / 2048))
            const samples: number[] = []
            const sensor = [e[12], e[13], e[14]]
            for (let index = 0; index < count; index += step) {
                const x = positions[index * 3],
                    y = positions[index * 3 + 1],
                    z = positions[index * 3 + 2]
                const world = [
                    e[0] * x + e[4] * y + e[8] * z + e[12],
                    e[1] * x + e[5] * y + e[9] * z + e[13],
                    e[2] * x + e[6] * y + e[10] * z + e[14],
                ]
                samples.push(
                    look.colorMode === "range"
                        ? Math.hypot(
                            world[0] - sensor[0],
                            world[1] - sensor[1],
                            world[2] - sensor[2],
                        )
                        : world[look.axis],
                )
            }
            samples.sort((a, b) => a - b)
            low = samples[Math.floor(samples.length * 0.05)]
            high = samples[Math.floor(samples.length * 0.95)]
            if (look.colorMode === "range") {
                low = 0
            }
        }
        if (!this.#rangeSeen) {
            this.#range = [low, high]
            this.#rangeSeen = true
        } else {
            this.#range = [
                this.#range[0] + (low - this.#range[0]) * 0.2,
                this.#range[1] + (high - this.#range[1]) * 0.2,
            ]
        }
        applyLook(this.#material, this.#look(), this.#range)
    }

    /** the playhead jumped (Replayer): an accumulated map starts over */
    reset() {
        if (this.#settings.get().mode === "accumulate") {
            this.#clear()
        }
    }

    update(frame: { now: number; fixedFrame: string }) {
        if (frame.fixedFrame !== this.#fixedFrame) {
            this.#fixedFrame = frame.fixedFrame
            if (this.#settings.get().mode === "accumulate") {
                this.#clear()
            }
        }
        this.#material.uniforms.uNow.value = mediaSeconds()
        if (
            this.#settings.get().mode === "accumulate" &&
            this.#settings.get().windowSeconds > 0
        ) {
            this.context.viewer.requestRender() // old points fade out by time even with no new scans
        }
        if (this.#frame !== null) {
            const placed = this.#settings.get().mode === "accumulate" ? true : placeInFixedFrame(
                this.context,
                this.#points,
                this.#frame,
                frame.fixedFrame,
            )
            if (placed) {
                const sensor = this.context.tf.lookup(this.#frame, frame.fixedFrame)
                if (sensor) {
                    this.#material.uniforms.uSensor.value.setFromMatrixPosition(sensor)
                }
            }
        }
        if (frame.now - this.#rate.since > 1000) {
            this.#rate.hz = (this.#rate.count * 1000) /
                (frame.now - this.#rate.since)
            this.#rate = { count: 0, since: frame.now, hz: this.#rate.hz }
            const shown = this.#settings.get().mode === "accumulate" ? `${formatCount(this.#filled)} kept · ` : ""
            this.context.setStatus({
                info: this.#frame === null
                    ? "waiting for frame_id…"
                    : `${shown}${formatCount(this.#lastCount)} pts · ${this.#rate.hz.toFixed(1)} Hz · ${
                        this.#frame || "no frame"
                    }`,
            })
        }
    }

    dispose() {
        clearInterval(this.#frameTimer)
        this.#unsubscribe.forEach((stop) => stop())
        this.#stopStream?.()
        this.#geometry.dispose()
        this.#material.dispose()
    }
}

const formatCount = (count: number) =>
    count >= 1e6
        ? `${(count / 1e6).toFixed(1)}M`
        : count >= 1000
        ? `${(count / 1000).toFixed(count >= 10000 ? 0 : 1)}k`
        : String(count)

function CloudSettingsEditor(
    { settings }: { settings: Store<CloudSettings>; topic: Topic },
) {
    const value = useStore(settings)
    return (
        <>
            <PointLookEditor
                look={value.look}
                onChange={(look) => settings.update({ look })}
            />
            <Field label="Keep">
                <Select
                    value={value.mode}
                    options={[["latest", "latest scan"], ["accumulate", "accumulate"]]}
                    onChange={(mode) => settings.update({ mode: mode as CloudSettings["mode"] })}
                />
            </Field>
            {value.mode === "accumulate" && (
                <Field label="Window">
                    <Select
                        value={String(value.windowSeconds)}
                        options={[["5", "5 s"], ["10", "10 s"], ["30", "30 s"], [
                            "120",
                            "2 min",
                        ], ["0", "forever"]]}
                        onChange={(seconds) => settings.update({ windowSeconds: Number(seconds) })}
                    />
                </Field>
            )}
            <Field label="Detail">
                <Select
                    value={value.detail}
                    options={[["auto", "auto (thins on slow links)"], [
                        "full",
                        "every point",
                    ]]}
                    onChange={(detail) => settings.update({ detail: detail as CloudSettings["detail"] })}
                />
            </Field>
            <Field label="Max rate">
                <Slider
                    min={1}
                    max={30}
                    step={1}
                    value={value.maxHz}
                    format={(hz) => `${hz} Hz`}
                    onChange={(maxHz) => settings.update({ maxHz })}
                />
            </Field>
        </>
    )
}

registerLayer<CloudSettings>({
    id: "pointcloud",
    label: "Point cloud",
    types: ["sensor_msgs.PointCloud2"],
    // MemWorld's look: lit spheres (a map's at its 10 cm voxel size), lit cubes as the "voxel" style
    defaults: (topic) =>
        isMap(topic) ? { ...DEFAULTS, look: { ...DEFAULTS.look, size: 0.1 } } : structuredClone(DEFAULTS),
    create: (context, topic, settings) => new CloudLayer(context, topic, settings),
    Settings: CloudSettingsEditor,
})

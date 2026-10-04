// nav_msgs.OccupancyGrid (costmaps, 2D maps): one textured plane at the grid's origin. A costmap is drawn like the
// Map Builder's floor plan: a dark navy floor where it's free, costs as dimmer-to-brighter cyan, lethal cells as a bright
// cyan rim around a dimmer body; unknown is clear. The texture is rebuilt in place, never reallocated for a same-size grid.
import * as THREE from "three"
import { type LayerContext, registerLayer } from "../core/layers/registry.ts"
import { placeInFixedFrame, poseMatrix, subscribeDecoded } from "../core/layers/helpers.ts"
import { type Store, useStore } from "../core/store.ts"
import type { Topic } from "../core/transport.ts"
import { Field, Select, Slider } from "../ui/controls.tsx"

export interface GridSettings {
    opacity: number
    style: "costmap" | "map"
    lift: number
}

// dim-map-builder's PLAN_STYLE (frontend/src/core/slice.ts)
const PLAN_FLOOR = [21, 33, 50]
const PLAN_WALL_BODY = [38, 78, 122]
const PLAN_WALL_RIM = [130, 212, 255]
/** a costmap's lethal value (dimos marks obstacles 100) */
const LETHAL = 100

const mix = (a: number[], b: number[], t: number) => a.map((value, index) => value + (b[index] - value) * t)

class GridLayer {
    readonly root = new THREE.Group()
    #mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
    #texture: THREE.DataTexture | null = null
    #stop: () => void
    #frame: string | null = null
    #lut = new Uint8Array(256 * 4)

    constructor(
        readonly context: LayerContext,
        readonly topic: Topic,
        readonly settings: Store<GridSettings>,
    ) {
        this.#mesh = new THREE.Mesh(
            new THREE.PlaneGeometry(1, 1),
            new THREE.MeshBasicMaterial({
                transparent: true,
                depthWrite: false,
                side: THREE.DoubleSide,
            }),
        )
        this.#mesh.matrixAutoUpdate = false
        this.root.add(this.#mesh)
        settings.subscribe(() => {
            this.#mesh.material.opacity = settings.get().opacity
            this.#buildLut()
            context.viewer.requestRender()
        })
        this.#mesh.material.opacity = settings.get().opacity
        this.#buildLut()
        this.#stop = subscribeDecoded(
            context,
            topic,
            { maxHz: 2 },
            (grid, timestamp) => this.#onGrid(grid, timestamp),
        )
    }

    /** value (-1..100, as the u8 it arrives as) → rgba */
    #buildLut() {
        const style = this.settings.get().style
        for (let byte = 0; byte < 256; byte++) {
            const value = byte > 127 ? byte - 256 : byte
            let rgba: [number, number, number, number]
            if (value < 0) {
                rgba = style === "map" ? [110, 120, 135, 40] : [0, 0, 0, 0]
            } else if (style === "map") {
                const shade = 235 - value * 2.2
                rgba = value === 0 ? [235, 240, 245, 70] : [shade, shade, shade, 230]
            } else if (value === 0) {
                rgba = [...PLAN_FLOOR, 215] as typeof rgba
            } else {
                // a cost brightens from the floor through the wall body toward the rim (lethal is drawn per cell, below)
                const t = Math.sqrt(Math.min(value, LETHAL - 1) / LETHAL)
                rgba = [
                    ...(t < 0.6
                        ? mix(PLAN_FLOOR, PLAN_WALL_BODY, t / 0.6)
                        : mix(PLAN_WALL_BODY, PLAN_WALL_RIM, (t - 0.6) / 0.4 * 0.7)),
                    235,
                ] as typeof rgba
            }
            this.#lut.set(rgba, byte * 4)
        }
    }

    // deno-lint-ignore no-explicit-any
    #onGrid(grid: any, timestamp: number) {
        const { width, height, resolution, origin } = grid.info ?? {}
        const data: Int8Array = grid.data
        if (!width || !height || !data || data.length < width * height) {
            this.context.setStatus({ problem: "empty or truncated grid" })
            return
        }
        this.#frame = grid.header?.frame_id ?? ""
        if (
            !this.#texture || this.#texture.image.width !== width ||
            this.#texture.image.height !== height
        ) {
            this.#texture?.dispose()
            this.#texture = new THREE.DataTexture(
                new Uint8Array(width * height * 4),
                width,
                height,
            )
            this.#texture.magFilter = THREE.NearestFilter
            this.#texture.colorSpace = THREE.SRGBColorSpace
            this.#mesh.material.map = this.#texture
            this.#mesh.material.needsUpdate = true
        }
        const pixels = this.#texture.image.data as Uint8Array
        const lut = this.#lut
        const bytes = new Uint8Array(data.buffer, data.byteOffset, width * height)
        const costmap = this.settings.get().style === "costmap"
        const lethal = (column: number, row: number) =>
            column < 0 || row < 0 || column >= width || row >= height ||
            bytes[row * width + column] === LETHAL
        for (let index = 0; index < width * height; index++) {
            if (costmap && bytes[index] === LETHAL) {
                // the floor plan's walls: a bright rim where a lethal cell borders anything else, a dimmer body inside
                const column = index % width, row = (index - column) / width
                const inside = lethal(column - 1, row) && lethal(column + 1, row) &&
                    lethal(column, row - 1) && lethal(column, row + 1)
                pixels.set(
                    [...(inside ? PLAN_WALL_BODY : PLAN_WALL_RIM), 255],
                    index * 4,
                )
                continue
            }
            const at = bytes[index] * 4
            pixels[index * 4] = lut[at]
            pixels[index * 4 + 1] = lut[at + 1]
            pixels[index * 4 + 2] = lut[at + 2]
            pixels[index * 4 + 3] = lut[at + 3]
        }
        this.#texture.needsUpdate = true
        // the plane spans the grid, its corner at the origin pose (cell (0,0) is the first row of data)
        const size = new THREE.Vector3(width * resolution, height * resolution, 1)
        const center = new THREE.Matrix4().makeTranslation(
            size.x / 2,
            size.y / 2,
            this.settings.get().lift,
        )
        this.#mesh.matrix.copy(poseMatrix(origin)).multiply(center).multiply(
            new THREE.Matrix4().makeScale(size.x, size.y, 1),
        )
        this.context.setStatus({
            info: `${width}×${height} @ ${resolution.toFixed(2)} m · ${this.#frame || "no frame"}`,
        })
        this.context.viewer.noteData(timestamp)
    }

    update(frame: { fixedFrame: string }) {
        if (this.#frame !== null) {
            placeInFixedFrame(this.context, this.root, this.#frame, frame.fixedFrame)
        }
    }

    dispose() {
        this.#stop()
        this.#texture?.dispose()
        this.#mesh.geometry.dispose()
        this.#mesh.material.dispose()
    }
}

function GridSettingsEditor(
    { settings }: { settings: Store<GridSettings>; topic: Topic },
) {
    const value = useStore(settings)
    return (
        <>
            <Field label="Style">
                <Select
                    value={value.style}
                    options={[["costmap", "costmap (floor plan)"], ["map", "map (gray)"]]}
                    onChange={(style) => settings.update({ style: style as GridSettings["style"] })}
                />
            </Field>
            <Field label="Opacity">
                <Slider
                    min={0.1}
                    max={1}
                    step={0.05}
                    value={value.opacity}
                    format={(opacity) => `${Math.round(opacity * 100)}%`}
                    onChange={(opacity) => settings.update({ opacity })}
                />
            </Field>
        </>
    )
}

registerLayer<GridSettings>({
    id: "occupancy",
    label: "Occupancy grid",
    types: ["nav_msgs.OccupancyGrid"],
    defaults: (topic) => ({
        opacity: 0.85,
        style: /cost/i.test(topic.name) ? "costmap" : "map",
        lift: 0.01,
    }),
    create: (context: LayerContext, topic, settings) => new GridLayer(context, topic, settings),
    Settings: GridSettingsEditor,
})

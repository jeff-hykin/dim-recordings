// nav_msgs.LineSegments3D: a node/edge graph (pose graphs, roadmaps). dimos sends it as a Path whose poses come in
// pairs (one edge each) with the edge weight in the first pose's orientation.w. Edges are colored by weight on a
// log scale, nodes (each distinct endpoint) drawn as points.
import * as THREE from "three"
import { type LayerContext, registerLayer } from "../core/layers/registry.ts"
import { placeInFixedFrame, subscribeDecoded } from "../core/layers/helpers.ts"
import { FatLines } from "../core/render/lines.ts"
import { sampleGradient } from "../core/render/gradients.ts"
import { applyLook, makePointMaterial } from "../core/render/pointMaterial.ts"
import { type Store, useStore } from "../core/store.ts"
import type { Topic } from "../core/transport.ts"
import { Field, Select, Slider, Toggle } from "../ui/controls.tsx"

export interface GraphSettings {
    width: number
    nodes: boolean
    nodeSize: number
    gradient: string
}

class GraphLayer {
    readonly root = new THREE.Group()
    #edges: FatLines
    #nodes: THREE.Points
    #nodeMaterial: THREE.ShaderMaterial
    #stop: () => void
    #frame: string | null = null

    constructor(
        readonly context: LayerContext,
        readonly topic: Topic,
        readonly settings: Store<GraphSettings>,
    ) {
        this.#edges = new FatLines(context.viewer.resolution, {
            width: settings.get().width,
            vertexColors: true,
        })
        this.#nodeMaterial = makePointMaterial(context.viewer.pixelsPerMeter)
        this.#nodes = new THREE.Points(
            new THREE.BufferGeometry(),
            this.#nodeMaterial,
        )
        this.#nodes.frustumCulled = false
        this.root.add(this.#edges.object, this.#nodes)
        settings.subscribe(() => this.#restyle())
        this.#restyle()
        this.#stop = subscribeDecoded(context, topic, {
            maxHz: 5,
            decodeAs: "nav_msgs.Path",
        }, (path, timestamp) => this.#onGraph(path, timestamp))
    }

    #restyle() {
        const settings = this.settings.get()
        this.#edges.material.linewidth = settings.width
        this.#nodes.visible = settings.nodes
        applyLook(this.#nodeMaterial, {
            style: "disc",
            size: settings.nodeSize,
            colorMode: "solid",
            gradient: settings.gradient,
            axis: 2,
            rangeMin: 0,
            rangeMax: 1,
            solid: "#f5f7fa",
            opacity: 1,
        }, [0, 1])
        this.context.viewer.requestRender()
    }

    // deno-lint-ignore no-explicit-any
    #onGraph(path: any, timestamp: number) {
        this.#frame = path.header?.frame_id ?? ""
        const poses = path.poses ?? []
        const edgeCount = Math.floor(poses.length / 2)
        const weights: number[] = []
        for (let index = 0; index < edgeCount; index++) {
            weights.push(poses[index * 2]?.pose?.orientation?.w ?? 1)
        }
        const logs = weights.map((weight) => Math.log10(Math.max(1e-6, Math.abs(weight))))
        const low = Math.min(...logs, 0), high = Math.max(...logs, low + 1e-6)
        const gradient = this.settings.get().gradient
        this.#edges.clear()
        const nodes = new Map<string, [number, number, number]>()
        const color = new THREE.Color()
        for (let index = 0; index < edgeCount; index++) {
            const a = poses[index * 2].pose.position,
                b = poses[index * 2 + 1].pose.position
            const [r, g, bl] = sampleGradient(
                gradient,
                (logs[index] - low) / (high - low),
            )
            color.setRGB(r / 255, g / 255, bl / 255, THREE.SRGBColorSpace)
            this.#edges.push(a.x, a.y, a.z, b.x, b.y, b.z, color)
            for (const point of [a, b]) {
                nodes.set(
                    `${point.x.toFixed(3)},${point.y.toFixed(3)},${point.z.toFixed(3)}`,
                    [point.x, point.y, point.z],
                )
            }
        }
        this.#edges.commit()
        const positions = new Float32Array(nodes.size * 3)
        let at = 0
        for (const [x, y, z] of nodes.values()) {
            positions[at++] = x
            positions[at++] = y
            positions[at++] = z
        }
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3))
        geometry.setAttribute(
            "aTime",
            new THREE.BufferAttribute(new Float32Array(nodes.size), 1),
        )
        geometry.setAttribute(
            "aIntensity",
            new THREE.BufferAttribute(new Float32Array(nodes.size), 1),
        )
        this.#nodes.geometry.dispose()
        this.#nodes.geometry = geometry
        this.context.setStatus({
            info: `${nodes.size} nodes · ${edgeCount} edges · ${this.#frame || "no frame"}`,
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
        this.#edges.dispose()
        this.#nodes.geometry.dispose()
        this.#nodeMaterial.dispose()
    }
}

function GraphSettingsEditor(
    { settings }: { settings: Store<GraphSettings>; topic: Topic },
) {
    const value = useStore(settings)
    return (
        <>
            <Field label="Edge width">
                <Slider
                    min={1}
                    max={8}
                    step={0.5}
                    value={value.width}
                    format={(width) => `${width}px`}
                    onChange={(width) => settings.update({ width })}
                />
            </Field>
            <Field label="Nodes">
                <Toggle
                    value={value.nodes}
                    onChange={(nodes) => settings.update({ nodes })}
                />
            </Field>
            <Field label="Node size">
                <Slider
                    min={0.02}
                    max={0.5}
                    step={0.01}
                    value={value.nodeSize}
                    format={(size) => `${Math.round(size * 100)} cm`}
                    onChange={(nodeSize) => settings.update({ nodeSize })}
                />
            </Field>
            <Field label="Weights">
                <Select
                    value={value.gradient}
                    options={[["viridis", "viridis"], ["turbo", "turbo"], [
                        "plasma",
                        "plasma",
                    ], ["magma", "magma"]]}
                    onChange={(gradient) => settings.update({ gradient })}
                />
            </Field>
        </>
    )
}

registerLayer<GraphSettings>({
    id: "graph",
    label: "Graph (nodes + edges)",
    types: ["nav_msgs.LineSegments3D"],
    defaults: { width: 2, nodes: true, nodeSize: 0.08, gradient: "viridis" },
    create: (context, topic, settings) => new GraphLayer(context, topic, settings),
    Settings: GraphSettingsEditor,
})

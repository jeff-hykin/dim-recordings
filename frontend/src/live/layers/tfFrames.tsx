// tf2_msgs.TFMessage topics, drawn: an axes gizmo and a name per frame, and a line from each frame to its parent.
// (Reading tf into the tree happens in core/tfFeed.ts whether or not this layer is on.)
import * as THREE from "three"
import { type LayerContext, registerLayer } from "../core/layers/registry.ts"
import { FatLines } from "../core/render/lines.ts"
import { LabelPool } from "../core/render/labels.ts"
import { type Store, useStore } from "../core/store.ts"
import type { Topic } from "../core/transport.ts"
import { Field, Slider, Toggle } from "../ui/controls.tsx"

export interface TfSettings {
    axesSize: number
    names: boolean
    links: boolean
}

const AXES_CAP = 512
const NAMES_CAP = 16

class TfFramesLayer {
    readonly root = new THREE.Group()
    #axes: FatLines
    #links: FatLines
    #labels = new LabelPool("scene-label frame-label")
    #version = -1
    #fixedFrame = ""

    constructor(
        readonly context: LayerContext,
        readonly settings: Store<TfSettings>,
    ) {
        this.#axes = new FatLines(context.viewer.resolution, {
            width: 2.5,
            vertexColors: true,
            capacity: AXES_CAP * 3,
        })
        this.#links = new FatLines(context.viewer.resolution, {
            width: 1,
            color: 0x9aa5b1,
            opacity: 0.6,
            dashed: false,
        })
        this.root.add(this.#axes.object, this.#links.object, this.#labels.group)
        settings.subscribe(() => {
            this.#version = -1
            context.viewer.requestRender()
        })
    }

    update(frame: { fixedFrame: string }) {
        // only redraw when the tree changed
        if (
            this.context.tf.version === this.#version &&
            frame.fixedFrame === this.#fixedFrame
        ) {
            return
        }
        this.#version = this.context.tf.version
        this.#fixedFrame = frame.fixedFrame
        const settings = this.settings.get()
        const snapshot = this.context.tf.snapshot(frame.fixedFrame)
        const red = new THREE.Color(0xef4444),
            green = new THREE.Color(0x22c55e),
            blue = new THREE.Color(0x3b82f6)
        this.#axes.clear()
        this.#links.clear()
        this.#labels.begin()
        const origin = new THREE.Vector3(),
            tip = new THREE.Vector3(),
            parent = new THREE.Vector3()
        let unplaced = 0
        for (const name of snapshot.frames.slice(0, AXES_CAP)) {
            const matrix = this.context.tf.lookup(name, frame.fixedFrame)
            if (!matrix) {
                unplaced++
                continue
            }
            origin.setFromMatrixPosition(matrix)
            for (
                const [axis, color] of [[new THREE.Vector3(1, 0, 0), red], [
                    new THREE.Vector3(0, 1, 0),
                    green,
                ], [new THREE.Vector3(0, 0, 1), blue]] as const
            ) {
                tip.copy(axis).multiplyScalar(settings.axesSize).applyMatrix4(matrix)
                this.#axes.push(
                    origin.x,
                    origin.y,
                    origin.z,
                    tip.x,
                    tip.y,
                    tip.z,
                    color,
                )
            }
            // a big tree (an arm, a humanoid) turns names into a pile; then only the robot and the fixed frame are named
            if (
                settings.names &&
                (snapshot.frames.length <= NAMES_CAP || name === frame.fixedFrame ||
                    name === this.context.profile.baseFrame)
            ) {
                this.#labels.place(name, origin)
            }
            const edge = snapshot.edges.find((other) => other.child === name)
            const parentMatrix = edge &&
                this.context.tf.lookup(edge.parent, frame.fixedFrame)
            if (settings.links && parentMatrix) {
                parent.setFromMatrixPosition(parentMatrix)
                this.#links.push(
                    origin.x,
                    origin.y,
                    origin.z,
                    parent.x,
                    parent.y,
                    parent.z,
                )
            }
        }
        this.#axes.commit()
        this.#links.commit()
        this.#labels.end()
        this.context.setStatus({
            info: `${snapshot.frames.length} frames`,
            problem: unplaced ? `${unplaced} frames not connected to "${frame.fixedFrame}"` : null,
        })
        this.context.viewer.requestRender()
    }

    dispose() {
        this.#axes.dispose()
        this.#links.dispose()
        this.#labels.dispose()
    }
}

function TfSettingsEditor(
    { settings }: { settings: Store<TfSettings>; topic: Topic },
) {
    const value = useStore(settings)
    return (
        <>
            <Field label="Axes">
                <Slider
                    min={0.05}
                    max={1}
                    step={0.05}
                    value={value.axesSize}
                    format={(size) => `${size} m`}
                    onChange={(axesSize) => settings.update({ axesSize })}
                />
            </Field>
            <Field label="Names">
                <Toggle
                    value={value.names}
                    onChange={(names) => settings.update({ names })}
                />
            </Field>
            <Field label="Links">
                <Toggle
                    value={value.links}
                    onChange={(links) => settings.update({ links })}
                />
            </Field>
        </>
    )
}

registerLayer<TfSettings>({
    id: "tf",
    label: "TF frames",
    types: ["tf2_msgs.TFMessage"],
    defaults: { axesSize: 0.25, names: true, links: true },
    // one tf topic drawing is enough: the others are the same tree
    enabledByDefault: (topic) => topic.name === "/tf",
    create: (context: LayerContext, _topic, settings) => new TfFramesLayer(context, settings),
    Settings: TfSettingsEditor,
})

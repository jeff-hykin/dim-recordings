// geometry_msgs.PoseArray (candidate poses, particle clouds, waypoints): an arrow per pose along its +x.
import * as THREE from "three"
import { type LayerContext, registerLayer } from "../core/layers/registry.ts"
import { colorFor, placeInFixedFrame, poseMatrix, subscribeDecoded } from "../core/layers/helpers.ts"
import { FatLines } from "../core/render/lines.ts"
import { type Store, useStore } from "../core/store.ts"
import type { Topic } from "../core/transport.ts"
import { Field, Slider } from "../ui/controls.tsx"

export interface ArrowSettings {
    length: number
    color: string
}

class PoseArrayLayer {
    readonly root = new THREE.Group()
    #lines: FatLines
    #stop: () => void
    #frame: string | null = null

    constructor(
        readonly context: LayerContext,
        readonly topic: Topic,
        readonly settings: Store<ArrowSettings>,
    ) {
        this.#lines = new FatLines(context.viewer.resolution, {
            width: 2.5,
            color: settings.get().color,
        })
        this.root.add(this.#lines.object)
        let last: { poses?: unknown[] } | null = null
        const draw = () => {
            if (!last) {
                return
            }
            const { length } = settings.get()
            this.#lines.clear()
            const matrix = new THREE.Matrix4()
            const points = [
                new THREE.Vector3(),
                new THREE.Vector3(length, 0, 0),
                new THREE.Vector3(length * 0.7, length * 0.2, 0),
                new THREE.Vector3(length * 0.7, -length * 0.2, 0),
            ]
            const placed = points.map(() => new THREE.Vector3())
            for (const pose of last.poses ?? []) {
                poseMatrix(pose, matrix)
                points.forEach((point, index) => placed[index].copy(point).applyMatrix4(matrix))
                const [tail, tip, left, right] = placed
                this.#lines.push(tail.x, tail.y, tail.z, tip.x, tip.y, tip.z)
                this.#lines.push(tip.x, tip.y, tip.z, left.x, left.y, left.z)
                this.#lines.push(tip.x, tip.y, tip.z, right.x, right.y, right.z)
            }
            this.#lines.commit()
            context.viewer.requestRender()
        }
        settings.subscribe(() => {
            this.#lines.material.color.set(settings.get().color)
            draw()
        })
        this.#stop = subscribeDecoded(
            context,
            topic,
            { maxHz: 10 },
            (message, timestamp) => {
                this.#frame = message.header?.frame_id ?? ""
                last = message
                draw()
                context.setStatus({
                    info: `${message.poses?.length ?? 0} poses · ${this.#frame || "no frame"}`,
                })
                context.viewer.noteData(timestamp)
            },
        )
    }

    update(frame: { fixedFrame: string }) {
        if (this.#frame !== null) {
            placeInFixedFrame(this.context, this.root, this.#frame, frame.fixedFrame)
        }
    }

    dispose() {
        this.#stop()
        this.#lines.dispose()
    }
}

function ArrowSettingsEditor(
    { settings }: { settings: Store<ArrowSettings>; topic: Topic },
) {
    const value = useStore(settings)
    return (
        <>
            <Field label="Length">
                <Slider
                    min={0.05}
                    max={2}
                    step={0.05}
                    value={value.length}
                    format={(length) => `${length} m`}
                    onChange={(length) => settings.update({ length })}
                />
            </Field>
            <Field label="Color">
                <input
                    type="color"
                    value={value.color}
                    onChange={(event) => settings.update({ color: event.target.value })}
                />
            </Field>
        </>
    )
}

registerLayer<ArrowSettings>({
    id: "posearray",
    label: "Pose array",
    types: ["geometry_msgs.PoseArray"],
    defaults: (topic) => ({
        length: 0.4,
        color: `#${colorFor(topic.name).getHexString()}`,
    }),
    create: (context: LayerContext, topic, settings) => new PoseArrayLayer(context, topic, settings),
    Settings: ArrowSettingsEditor,
})

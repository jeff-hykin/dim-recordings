// vision_msgs.Detection3DArray / Detection3D / BoundingBox3DArray: wireframe boxes with a "class score" label,
// colored per class so the same kind of object keeps its color.
import * as THREE from "three"
import { type LayerContext, registerLayer } from "../core/layers/registry.ts"
import { colorFor, placeInFixedFrame, poseMatrix, subscribeDecoded } from "../core/layers/helpers.ts"
import { FatLines, pushBox } from "../core/render/lines.ts"
import { LabelPool } from "../core/render/labels.ts"
import type { LcmValue } from "../core/lcm/lcm.ts"
import { type Store, useStore } from "../core/store.ts"
import type { Topic } from "../core/transport.ts"
import { Field, Slider, Toggle } from "../ui/controls.tsx"

export interface BoxSettings {
    width: number
    labels: boolean
}

interface Box {
    pose: LcmValue
    size: LcmValue
    label: string
    className: string
}

function boxesOf(type: string, message: LcmValue): Box[] {
    if (type === "vision_msgs.BoundingBox3DArray") {
        return (message.boxes ?? []).map((box: LcmValue, index: number) => ({
            pose: box.center,
            size: box.size,
            label: `#${index}`,
            className: "box",
        }))
    }
    const detections = type === "vision_msgs.Detection3D" ? [message] : message.detections ?? []
    return detections.map((detection: LcmValue) => {
        const best = [...(detection.results ?? [])].sort((a: LcmValue, b: LcmValue) =>
            (b.hypothesis?.score ?? 0) - (a.hypothesis?.score ?? 0)
        )[0]
        const className = best?.hypothesis?.class_id || detection.id || "object"
        const score = best?.hypothesis?.score
        return {
            pose: detection.bbox?.center,
            size: detection.bbox?.size,
            label: score !== undefined ? `${className} ${(score * 100).toFixed(0)}%` : className,
            className,
        }
    })
}

class BoxLayer {
    readonly root = new THREE.Group()
    #lines: FatLines
    #labels = new LabelPool()
    #stop: () => void
    #frame: string | null = null

    constructor(
        readonly context: LayerContext,
        readonly topic: Topic,
        readonly settings: Store<BoxSettings>,
    ) {
        this.#lines = new FatLines(context.viewer.resolution, {
            width: settings.get().width,
            vertexColors: true,
        })
        this.root.add(this.#lines.object, this.#labels.group)
        settings.subscribe(() => {
            this.#lines.material.linewidth = settings.get().width
            this.#labels.group.visible = settings.get().labels
            context.viewer.requestRender()
        })
        this.#stop = subscribeDecoded(
            context,
            topic,
            { maxHz: 15 },
            (message, timestamp) => {
                this.#frame = message.header?.frame_id ?? ""
                const boxes = boxesOf(topic.type, message)
                this.#lines.clear()
                this.#labels.begin()
                const matrix = new THREE.Matrix4()
                const top = new THREE.Vector3()
                for (const box of boxes) {
                    const color = colorFor(box.className)
                    poseMatrix(box.pose, matrix)
                    pushBox(this.#lines, matrix, {
                        x: box.size?.x ?? 0.1,
                        y: box.size?.y ?? 0.1,
                        z: box.size?.z ?? 0.1,
                    }, color)
                    top.set(0, 0, (box.size?.z ?? 0) / 2).applyMatrix4(matrix)
                    this.#labels.place(box.label, top, `#${color.getHexString()}`)
                }
                this.#lines.commit()
                this.#labels.end()
                context.setStatus({
                    info: `${boxes.length} boxes · ${this.#frame || "no frame"}`,
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
        this.#labels.dispose()
    }
}

function BoxSettingsEditor(
    { settings }: { settings: Store<BoxSettings>; topic: Topic },
) {
    const value = useStore(settings)
    return (
        <>
            <Field label="Width">
                <Slider
                    min={1}
                    max={8}
                    step={0.5}
                    value={value.width}
                    format={(width) => `${width}px`}
                    onChange={(width) => settings.update({ width })}
                />
            </Field>
            <Field label="Labels">
                <Toggle
                    value={value.labels}
                    onChange={(labels) => settings.update({ labels })}
                />
            </Field>
        </>
    )
}

registerLayer<BoxSettings>({
    id: "boxes3d",
    label: "3D boxes",
    types: [
        "vision_msgs.Detection3DArray",
        "vision_msgs.Detection3D",
        "vision_msgs.BoundingBox3DArray",
    ],
    defaults: { width: 2.5, labels: true },
    create: (context: LayerContext, topic, settings) => new BoxLayer(context, topic, settings),
    Settings: BoxSettingsEditor,
})

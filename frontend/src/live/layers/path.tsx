// nav_msgs.Path (planned paths): a thick line through the poses, placed by its header's frame.
import * as THREE from "three"
import { type LayerContext, registerLayer } from "../core/layers/registry.ts"
import { colorFor, placeInFixedFrame, subscribeDecoded } from "../core/layers/helpers.ts"
import { FatLines } from "../core/render/lines.ts"
import { type Store, useStore } from "../core/store.ts"
import type { Topic } from "../core/transport.ts"
import { Field, Slider } from "../ui/controls.tsx"

export interface PathSettings {
    color: string
    width: number
    /** lift above the floor so a path on z=0 isn't hidden by the grid */
    lift: number
}

class PathLayer {
    readonly root = new THREE.Group()
    #lines: FatLines
    #stop: () => void
    #frame: string | null = null

    constructor(
        readonly context: LayerContext,
        readonly topic: Topic,
        readonly settings: Store<PathSettings>,
    ) {
        this.#lines = new FatLines(context.viewer.resolution, {
            width: settings.get().width,
            color: settings.get().color,
        })
        this.root.add(this.#lines.object)
        settings.subscribe(() => {
            this.#lines.material.color.set(settings.get().color)
            this.#lines.material.linewidth = settings.get().width
            context.viewer.requestRender()
        })
        this.#stop = subscribeDecoded(
            context,
            topic,
            { maxHz: 10 },
            (path, timestamp) => {
                this.#frame = path.header?.frame_id ?? ""
                const lift = settings.get().lift
                this.#lines.clear()
                let previous: { x: number; y: number; z: number } | null = null
                for (const stamped of path.poses ?? []) {
                    const position = stamped?.pose?.position
                    if (
                        !position || !Number.isFinite(position.x) ||
                        !Number.isFinite(position.y)
                    ) {
                        continue
                    }
                    if (previous) {
                        this.#lines.push(
                            previous.x,
                            previous.y,
                            previous.z + lift,
                            position.x,
                            position.y,
                            position.z + lift,
                        )
                    }
                    previous = position
                }
                this.#lines.commit()
                context.setStatus({
                    info: `${path.poses?.length ?? 0} poses · ${this.#frame || "no frame"}`,
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

function PathSettingsEditor(
    { settings }: { settings: Store<PathSettings>; topic: Topic },
) {
    const value = useStore(settings)
    return (
        <>
            <Field label="Color">
                <input
                    type="color"
                    value={value.color}
                    onChange={(event) => settings.update({ color: event.target.value })}
                />
            </Field>
            <Field label="Width">
                <Slider
                    min={1}
                    max={10}
                    step={0.5}
                    value={value.width}
                    format={(width) => `${width}px`}
                    onChange={(width) => settings.update({ width })}
                />
            </Field>
        </>
    )
}

registerLayer<PathSettings>({
    id: "path",
    label: "Path",
    types: ["nav_msgs.Path"],
    defaults: (topic) => ({
        color: `#${colorFor(topic.name + "path").getHexString()}`,
        width: 4,
        lift: 0.03,
    }),
    create: (context, topic, settings) => new PathLayer(context, topic, settings),
    Settings: PathSettingsEditor,
})

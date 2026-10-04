// Labeled points: visualization_msgs.EntityMarkers (dimos's people/objects/places, JSON after a u32 length, no
// fingerprint) and geometry_msgs.PointStamped (a clicked point, a goal). A sphere and a text label each.
import * as THREE from "three"
import { type LayerContext, registerLayer } from "../core/layers/registry.ts"
import { colorFor, placeInFixedFrame, subscribeDecoded } from "../core/layers/helpers.ts"
import { LabelPool } from "../core/render/labels.ts"
import type { Topic } from "../core/transport.ts"

const ENTITY_COLORS: Record<string, string> = {
    person: "#ff6464",
    object: "#64ff64",
    location: "#6464ff",
}

interface Entity {
    label: string
    color: string
    position: THREE.Vector3
}

function entitiesOf(_topic: Topic, bytes: Uint8Array): Entity[] {
    const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0)
    const list = JSON.parse(
        new TextDecoder().decode(bytes.subarray(4, 4 + length)),
    ) as {
        id: string
        label: string
        type: string
        x: number
        y: number
        z: number
    }[]
    return list.map((entity) => ({
        label: `${entity.id}: ${String(entity.label).slice(0, 40)}`,
        color: ENTITY_COLORS[entity.type] ?? "#c8c8c8",
        position: new THREE.Vector3(entity.x, entity.y, entity.z),
    }))
}

const sphere = new THREE.SphereGeometry(1, 16, 12)

class LabeledPoints {
    readonly root = new THREE.Group()
    #labels = new LabelPool()
    #spheres: THREE.InstancedMesh
    #stop: () => void
    #frame: string | null = null

    constructor(readonly context: LayerContext, readonly topic: Topic) {
        this.#spheres = new THREE.InstancedMesh(
            sphere,
            new THREE.MeshLambertMaterial(),
            256,
        )
        this.#spheres.count = 0
        this.#spheres.frustumCulled = false
        this.root.add(this.#spheres, this.#labels.group)
        const show = (entities: Entity[], frame: string, timestamp: number) => {
            this.#frame = frame
            this.#labels.begin()
            const matrix = new THREE.Matrix4()
            const count = Math.min(entities.length, 256)
            for (let index = 0; index < count; index++) {
                const entity = entities[index]
                this.#spheres.setMatrixAt(
                    index,
                    matrix.makeScale(0.12, 0.12, 0.12).setPosition(entity.position),
                )
                this.#spheres.setColorAt(index, new THREE.Color(entity.color))
                this.#labels.place(
                    entity.label,
                    entity.position.clone().setZ(entity.position.z + 0.25),
                    entity.color,
                )
            }
            this.#spheres.count = count
            this.#spheres.instanceMatrix.needsUpdate = true
            if (this.#spheres.instanceColor) {
                this.#spheres.instanceColor.needsUpdate = true
            }
            this.#labels.end()
            context.setStatus({ info: `${entities.length} points` })
            context.viewer.noteData(timestamp)
        }
        if (topic.type === "visualization_msgs.EntityMarkers") {
            // world coordinates by definition (dimos draws them in rerun's world)
            this.#stop = context.connection.subscribe(topic.key, {
                delivery: "latest",
                maxHz: 5,
            }, (message) => {
                try {
                    show(entitiesOf(topic, message.bytes), "", message.timestamp)
                } catch (error) {
                    context.setStatus({ problem: `cannot decode: ${error}` })
                }
            })
        } else {
            this.#stop = subscribeDecoded(
                context,
                topic,
                { maxHz: 10 },
                (message, timestamp) => {
                    const point = message.point ?? {}
                    show(
                        [{
                            label: topic.name,
                            color: `#${colorFor(topic.name).getHexString()}`,
                            position: new THREE.Vector3(point.x, point.y, point.z),
                        }],
                        message.header?.frame_id ?? "",
                        timestamp,
                    )
                },
            )
        }
    }

    update(frame: { fixedFrame: string }) {
        if (this.#frame !== null) {
            placeInFixedFrame(this.context, this.root, this.#frame, frame.fixedFrame)
        }
    }

    dispose() {
        this.#stop()
        this.#spheres.dispose()
        this.#labels.dispose()
    }
}

registerLayer({
    id: "labeled-points",
    label: "Labeled points",
    types: ["visualization_msgs.EntityMarkers", "geometry_msgs.PointStamped"],
    defaults: {},
    create: (context: LayerContext, topic: Topic) => new LabeledPoints(context, topic),
})

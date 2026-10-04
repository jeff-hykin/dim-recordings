// visualization_msgs.Marker / MarkerArray: every marker type RViz draws except meshes (MESH_RESOURCE shows its
// bounding box and is reported). Markers are kept by (ns, id), replaced on ADD, removed on DELETE/DELETEALL or when
// their lifetime runs out, and each is placed by its own header's frame every frame.
import * as THREE from "three"
import { type LayerContext, registerLayer } from "../core/layers/registry.ts"
import { disposeTree, poseMatrix, rgba, subscribeDecoded } from "../core/layers/helpers.ts"
import { FatLines } from "../core/render/lines.ts"
import { LabelPool } from "../core/render/labels.ts"
import type { LcmValue } from "../core/lcm/lcm.ts"
import type { Store } from "../core/store.ts"
import type { Topic } from "../core/transport.ts"

const TYPE = {
    ARROW: 0,
    CUBE: 1,
    SPHERE: 2,
    CYLINDER: 3,
    LINE_STRIP: 4,
    LINE_LIST: 5,
    CUBE_LIST: 6,
    SPHERE_LIST: 7,
    POINTS: 8,
    TEXT: 9,
    MESH: 10,
    TRIANGLES: 11,
}
const ACTION = { ADD: 0, DELETE: 2, DELETEALL: 3 }

const unitBox = new THREE.BoxGeometry(1, 1, 1)
const unitSphere = new THREE.SphereGeometry(0.5, 20, 14)
// three's cylinders run along Y; markers' along Z
const unitCylinder = new THREE.CylinderGeometry(0.5, 0.5, 1, 24).rotateX(
    Math.PI / 2,
)
const unitCone = new THREE.ConeGeometry(0.5, 1, 20)
const shared = new Set<THREE.BufferGeometry>([
    unitBox,
    unitSphere,
    unitCylinder,
    unitCone,
])

interface Kept {
    object: THREE.Object3D
    frame: string
    pose: THREE.Matrix4
    expiresAt: number
    label?: { text: string; position: THREE.Vector3; color: string }
}

function material(color: LcmValue): THREE.Material {
    const { color: rgb, alpha } = rgba(color)
    return new THREE.MeshLambertMaterial({
        color: rgb,
        transparent: alpha < 1,
        opacity: alpha,
        side: THREE.DoubleSide,
    })
}

function arrow(marker: LcmValue): THREE.Object3D {
    const group = new THREE.Group()
    const scale = marker.scale ?? {}
    let start = new THREE.Vector3(), end = new THREE.Vector3(scale.x || 1, 0, 0)
    let shaft = scale.y || 0.05, head = scale.z || 0.1, headLength = 0
    if ((marker.points ?? []).length >= 2) {
        // points form: start→end, scale = shaft diameter, head diameter, head length
        start = new THREE.Vector3(
            marker.points[0].x,
            marker.points[0].y,
            marker.points[0].z,
        )
        end = new THREE.Vector3(
            marker.points[1].x,
            marker.points[1].y,
            marker.points[1].z,
        )
        shaft = scale.x || 0.05
        head = scale.y || shaft * 2
        headLength = scale.z || 0
    }
    const direction = end.clone().sub(start)
    const length = direction.length() || 1e-3
    headLength = headLength || Math.min(length * 0.3, head * 1.5)
    const paint = material(marker.color)
    const body = new THREE.Mesh(unitCylinder, paint)
    body.scale.set(shaft, shaft, Math.max(1e-3, length - headLength))
    body.position.set(0, 0, (length - headLength) / 2)
    const tip = new THREE.Mesh(unitCone, paint)
    tip.rotation.x = Math.PI / 2
    tip.scale.set(head, headLength, head)
    tip.position.set(0, 0, length - headLength / 2)
    group.add(body, tip)
    group.position.copy(start)
    group.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        direction.normalize(),
    )
    const wrapper = new THREE.Group()
    wrapper.add(group)
    return wrapper
}

function points(marker: LcmValue): THREE.Vector3[] {
    return (marker.points ?? []).map((point: LcmValue) => new THREE.Vector3(point.x, point.y, point.z))
}

function colors(marker: LcmValue, count: number): THREE.Color[] | null {
    const list = marker.colors ?? []
    return list.length === count ? list.map((color: LcmValue) => rgba(color).color) : null
}

class MarkerLayer {
    readonly root = new THREE.Group()
    #kept = new Map<string, Kept>()
    #labels = new LabelPool()
    #stop: () => void
    #unsupported = 0

    constructor(readonly context: LayerContext, readonly topic: Topic) {
        this.root.add(this.#labels.group)
        const isArray = topic.type === "visualization_msgs.MarkerArray"
        this.#stop = subscribeDecoded(context, topic, {
            maxHz: 30,
            reliable: isArray,
        }, (message, timestamp) => {
            for (const marker of isArray ? message.markers ?? [] : [message]) {
                this.#apply(marker)
            }
            context.viewer.noteData(timestamp)
        })
    }

    #apply(marker: LcmValue) {
        const key = `${marker.ns}/${marker.id}`
        if (marker.action === ACTION.DELETEALL) {
            for (const [other] of this.#kept) {
                if (!marker.ns || other.startsWith(`${marker.ns}/`)) {
                    this.#remove(other)
                }
            }
            return
        }
        this.#remove(key)
        if (marker.action === ACTION.DELETE) {
            return
        }
        const object = this.#build(marker)
        if (!object) {
            return
        }
        object.matrixAutoUpdate = false
        const lifetime = (marker.lifetime?.sec ?? 0) +
            (marker.lifetime?.nsec ?? 0) / 1e9
        const kept: Kept = {
            object,
            frame: marker.header?.frame_id ?? "",
            pose: poseMatrix(marker.pose),
            expiresAt: lifetime > 0 ? performance.now() + lifetime * 1000 : Infinity,
        }
        if (marker.type === TYPE.TEXT) {
            const { color } = rgba(marker.color)
            kept.label = {
                text: marker.text ?? "",
                position: new THREE.Vector3(),
                color: `#${color.getHexString()}`,
            }
        }
        this.#kept.set(key, kept)
        this.root.add(object)
    }

    #build(marker: LcmValue): THREE.Object3D | null {
        const scale = marker.scale ?? { x: 1, y: 1, z: 1 }
        const sized = (geometry: THREE.BufferGeometry) => {
            const mesh = new THREE.Mesh(geometry, material(marker.color))
            mesh.scale.set(scale.x || 1e-3, scale.y || 1e-3, scale.z || 1e-3)
            const group = new THREE.Group()
            group.add(mesh)
            return group
        }
        switch (marker.type) {
            case TYPE.ARROW:
                return arrow(marker)
            case TYPE.CUBE:
                return sized(unitBox)
            case TYPE.SPHERE:
                return sized(unitSphere)
            case TYPE.CYLINDER:
                return sized(unitCylinder)
            case TYPE.MESH:
                this.#unsupported++
                this.context.setStatus({
                    problem: `${this.#unsupported} MESH_RESOURCE marker(s) drawn as their bounding box`,
                })
                return sized(unitBox)
            case TYPE.LINE_STRIP:
            case TYPE.LINE_LIST: {
                const list = points(marker)
                const perPoint = colors(marker, list.length)
                const lines = new FatLines(this.context.viewer.resolution, {
                    width: Math.max(0.005, scale.x || 0.02),
                    worldUnits: true,
                    vertexColors: !!perPoint,
                    color: rgba(marker.color).color,
                })
                const step = marker.type === TYPE.LINE_LIST ? 2 : 1
                for (let index = 0; index + 1 < list.length; index += step) {
                    const a = list[index], b = list[index + 1]
                    lines.push(a.x, a.y, a.z, b.x, b.y, b.z, perPoint?.[index])
                }
                lines.commit()
                const group = new THREE.Group()
                group.add(lines.object)
                return group
            }
            case TYPE.CUBE_LIST:
            case TYPE.SPHERE_LIST: {
                const list = points(marker)
                const mesh = new THREE.InstancedMesh(
                    marker.type === TYPE.CUBE_LIST ? unitBox : unitSphere,
                    material(marker.color),
                    Math.max(1, list.length),
                )
                const perPoint = colors(marker, list.length)
                const matrix = new THREE.Matrix4()
                list.forEach((point, index) => {
                    mesh.setMatrixAt(
                        index,
                        matrix.makeScale(scale.x || 0.05, scale.y || 0.05, scale.z || 0.05)
                            .setPosition(point),
                    )
                    if (perPoint) {
                        mesh.setColorAt(index, perPoint[index])
                    }
                })
                mesh.count = list.length
                mesh.frustumCulled = false
                const group = new THREE.Group()
                group.add(mesh)
                return group
            }
            case TYPE.POINTS: {
                const list = points(marker)
                const geometry = new THREE.BufferGeometry().setFromPoints(list)
                const perPoint = colors(marker, list.length)
                if (perPoint) {
                    geometry.setAttribute(
                        "color",
                        new THREE.Float32BufferAttribute(
                            perPoint.flatMap((color) => [color.r, color.g, color.b]),
                            3,
                        ),
                    )
                }
                const { color, alpha } = rgba(marker.color)
                const cloud = new THREE.Points(
                    geometry,
                    new THREE.PointsMaterial({
                        size: scale.x || 0.05,
                        color: perPoint ? 0xffffff : color,
                        vertexColors: !!perPoint,
                        transparent: alpha < 1,
                        opacity: alpha,
                    }),
                )
                const group = new THREE.Group()
                group.add(cloud)
                return group
            }
            case TYPE.TEXT:
                return new THREE.Group()
            case TYPE.TRIANGLES: {
                const list = points(marker)
                const geometry = new THREE.BufferGeometry().setFromPoints(list)
                const perPoint = colors(marker, list.length)
                if (perPoint) {
                    geometry.setAttribute(
                        "color",
                        new THREE.Float32BufferAttribute(
                            perPoint.flatMap((color) => [color.r, color.g, color.b]),
                            3,
                        ),
                    )
                }
                geometry.computeVertexNormals()
                const paint = material(marker.color) as THREE.MeshLambertMaterial
                paint.vertexColors = !!perPoint
                const mesh = new THREE.Mesh(geometry, paint)
                mesh.scale.set(scale.x || 1, scale.y || 1, scale.z || 1)
                const group = new THREE.Group()
                group.add(mesh)
                return group
            }
        }
        this.context.setStatus({ problem: `unknown marker type ${marker.type}` })
        return null
    }

    #remove(key: string) {
        const kept = this.#kept.get(key)
        if (!kept) {
            return
        }
        this.#kept.delete(key)
        kept.object.traverse((child) => {
            const mesh = child as THREE.Mesh
            if (mesh.geometry && shared.has(mesh.geometry)) {
                ;(mesh as { geometry: THREE.BufferGeometry | null }).geometry = null
            }
        })
        disposeTree(kept.object)
    }

    update(frame: { now: number; fixedFrame: string }) {
        const missing = new Set<string>()
        this.#labels.begin()
        const scratch = new THREE.Vector3()
        for (const [key, kept] of this.#kept) {
            if (frame.now > kept.expiresAt) {
                this.#remove(key)
                this.context.viewer.requestRender()
                continue
            }
            const world = this.context.tf.lookup(kept.frame, frame.fixedFrame)
            kept.object.visible = !!world
            if (!world) {
                missing.add(kept.frame)
                continue
            }
            kept.object.matrix.multiplyMatrices(world, kept.pose)
            kept.object.matrixWorldNeedsUpdate = true
            if (kept.label) {
                this.#labels.place(
                    kept.label.text,
                    scratch.setFromMatrixPosition(kept.object.matrix),
                    kept.label.color,
                )
            }
        }
        this.#labels.end()
        this.context.setStatus({
            info: `${this.#kept.size} markers`,
            problem: missing.size
                ? `no TF path to "${frame.fixedFrame}" from ${[...missing].map((name) => `"${name}"`).join(", ")}`
                : null,
        })
    }

    dispose() {
        this.#stop()
        for (const key of [...this.#kept.keys()]) {
            this.#remove(key)
        }
        this.#labels.dispose()
    }
}

registerLayer({
    id: "marker",
    label: "Markers",
    types: ["visualization_msgs.Marker", "visualization_msgs.MarkerArray"],
    defaults: {},
    create: (context: LayerContext, topic: Topic, _settings: Store<object>) => new MarkerLayer(context, topic),
})

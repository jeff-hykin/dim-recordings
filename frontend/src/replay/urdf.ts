// A URDF as dimos's UrdfManager shares it, ported from the Controller (its core/urdf.ts and core/robotDescription.ts):
// the XML on /robot_description (std_msgs.String) and each mesh's file on /file_info or a topic under it (files.MeshFile,
// named by its `package://` URI, `?hash=<sha256>` included; older recordings: /urdf_info and /mesh_info). parseUrdf turns the XML into links and joints, meshGeometry a mesh file into a geometry,
// Kinematics does the forward kinematics and UrdfModel is the three.js robot, filled in as meshes arrive.
import * as THREE from "three"
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js"
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js"
import { ColladaLoader } from "three/examples/jsm/loaders/ColladaLoader.js"
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js"

type V3 = [number, number, number]
type Q = [number, number, number, number]
type Rgba = [number, number, number, number]

export interface Origin {
    xyz: V3
    quat: Q
}

export interface UrdfGeometry {
    type: "mesh" | "box" | "cylinder" | "sphere"
    origin: Origin
    mesh?: string
    scale?: V3
    size?: V3
    radius?: number
    length?: number
    color?: Rgba
}

export interface UrdfLink {
    name: string
    visuals: UrdfGeometry[]
    collisions: UrdfGeometry[]
}

export interface UrdfJoint {
    name: string
    type: "revolute" | "continuous" | "prismatic" | "fixed" | "floating" | "planar"
    parent: string
    child: string
    origin: Origin
    axis: V3
    mimic?: { joint: string; multiplier: number; offset: number }
}

export interface UrdfDescription {
    name: string
    links: UrdfLink[]
    joints: UrdfJoint[]
}

const numbers = (text: string | null | undefined, fallback: V3): V3 => {
    const parts = (text ?? "").trim().split(/\s+/).map(Number)
    return parts.length === 3 && parts.every(Number.isFinite) ? parts as V3 : fallback
}

function originOf(element: Element | null): Origin {
    const xyz = numbers(element?.getAttribute("xyz"), [0, 0, 0])
    const [roll, pitch, yaw] = numbers(element?.getAttribute("rpy"), [0, 0, 0])
    // URDF rpy is fixed-axis roll, pitch, yaw: R = Rz(yaw) Ry(pitch) Rx(roll), three's "ZYX" order
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(roll, pitch, yaw, "ZYX"))
    return { xyz, quat: [quaternion.x, quaternion.y, quaternion.z, quaternion.w] }
}

/** child elements (childNodes, not `children`, so any DOM implementation will do) */
const elements = (element: Element) =>
    Array.from(element.childNodes).filter((node): node is Element => node.nodeType === 1)
const child = (element: Element, name: string) => elements(element).find((each) => each.tagName === name) ?? null
const children = (element: Element, name: string) => elements(element).filter((each) => each.tagName === name)

function colorOf(material: Element | null, named: Map<string, Rgba>): Rgba | undefined {
    if (!material) {
        return undefined
    }
    const rgba = child(material, "color")?.getAttribute("rgba")?.trim().split(/\s+/).map(Number)
    if (rgba?.length === 4 && rgba.every(Number.isFinite)) {
        return rgba as Rgba
    }
    return named.get(material.getAttribute("name") ?? "")
}

function geometryOf(item: Element, named: Map<string, Rgba>): UrdfGeometry | null {
    const holder = child(item, "geometry")
    const shape = holder && elements(holder)[0]
    if (!shape) {
        return null
    }
    const geometry: UrdfGeometry = {
        type: "box",
        origin: originOf(child(item, "origin")),
        color: colorOf(child(item, "material"), named),
    }
    switch (shape.tagName) {
        case "mesh":
            geometry.type = "mesh"
            geometry.mesh = shape.getAttribute("filename") ?? ""
            geometry.scale = numbers(shape.getAttribute("scale"), [1, 1, 1])
            return geometry.mesh ? geometry : null
        case "box":
            geometry.size = numbers(shape.getAttribute("size"), [0.1, 0.1, 0.1])
            return geometry
        case "cylinder":
            geometry.type = "cylinder"
            geometry.radius = Number(shape.getAttribute("radius") ?? 0.05)
            geometry.length = Number(shape.getAttribute("length") ?? 0.1)
            return geometry
        case "sphere":
            geometry.type = "sphere"
            geometry.radius = Number(shape.getAttribute("radius") ?? 0.05)
            return geometry
    }
    return null
}

/** A URDF's XML as links and joints (meshes by URI, loaded apart). */
export function parseUrdf(xml: string): UrdfDescription {
    const document = new DOMParser().parseFromString(xml, "text/xml")
    const robot = document.documentElement
    if (!robot || robot.tagName !== "robot") {
        throw new Error("not a URDF: no <robot>")
    }
    const named = new Map<string, Rgba>()
    for (const material of children(robot, "material")) {
        const color = colorOf(material, new Map())
        if (color) {
            named.set(material.getAttribute("name") ?? "", color)
        }
    }
    const links = children(robot, "link").map((link) => ({
        name: link.getAttribute("name") ?? "",
        visuals: children(link, "visual").map((item) => geometryOf(item, named)).filter((item): item is UrdfGeometry =>
            !!item
        ),
        collisions: children(link, "collision").map((item) => geometryOf(item, named)).filter((
            item,
        ): item is UrdfGeometry => !!item),
    }))
    const joints: UrdfJoint[] = children(robot, "joint").map((joint) => {
        const mimic = child(joint, "mimic")
        return {
            name: joint.getAttribute("name") ?? "",
            type: (joint.getAttribute("type") ?? "fixed") as UrdfJoint["type"],
            parent: child(joint, "parent")?.getAttribute("link") ?? "",
            child: child(joint, "child")?.getAttribute("link") ?? "",
            origin: originOf(child(joint, "origin")),
            axis: numbers(child(joint, "axis")?.getAttribute("xyz"), [1, 0, 0]),
            ...(mimic
                ? {
                    mimic: {
                        joint: mimic.getAttribute("joint") ?? "",
                        multiplier: Number(mimic.getAttribute("multiplier") ?? 1),
                        offset: Number(mimic.getAttribute("offset") ?? 0),
                    },
                }
                : {}),
        }
    })
    return { name: robot.getAttribute("name") ?? "robot", links, joints }
}

/** Every mesh URI the description's links use, once each. */
export function meshUris(description: UrdfDescription): string[] {
    const uris = description.links.flatMap((link) => [...link.visuals, ...link.collisions]).map((item) => item.mesh)
        .filter((uri): uri is string => !!uri)
    return [...new Set(uris)]
}

/** files.MeshFile's wire form (shape_msgs.MeshFile's before it): `<f64 ts><u32 uri length><uri><file bytes>`, little endian. */
export function decodeMeshFile(bytes: Uint8Array): { ts: number; uri: string; data: Uint8Array } {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (bytes.byteLength < 12) {
        throw new Error(`MeshFile too short (${bytes.byteLength} bytes)`)
    }
    const uriLength = view.getUint32(8, true)
    if (12 + uriLength > bytes.byteLength) {
        throw new Error("MeshFile's uri runs past its end")
    }
    return {
        ts: view.getFloat64(0, true),
        uri: new TextDecoder().decode(bytes.subarray(12, 12 + uriLength)),
        data: bytes.subarray(12 + uriLength),
    }
}

/** The meshes of an OBJ or DAE scene as one geometry (positions only, in the scene's frame; materials dropped). */
function mergedMeshes(scene: THREE.Object3D): THREE.BufferGeometry {
    scene.updateMatrixWorld(true)
    const parts: THREE.BufferGeometry[] = []
    scene.traverse((object) => {
        const mesh = object as THREE.Mesh
        if (mesh.isMesh && mesh.geometry.attributes.position) {
            const part = new THREE.BufferGeometry()
            part.setAttribute("position", mesh.geometry.attributes.position.clone())
            part.setIndex(mesh.geometry.index ? mesh.geometry.index.clone() : null)
            parts.push(part.applyMatrix4(mesh.matrixWorld).toNonIndexed())
        }
    })
    if (!parts.length) {
        throw new Error("no meshes in the file")
    }
    const merged = mergeGeometries(parts)
    parts.forEach((part) => part.dispose())
    merged.computeVertexNormals()
    return merged
}

/** A mesh file (STL binary or ASCII, OBJ, DAE) as a BufferGeometry in meters, its kind told by the URI's extension. */
export function meshGeometry(uri: string, data: Uint8Array): THREE.BufferGeometry {
    const extension = uri.split("?")[0].split(".").pop()?.toLowerCase()
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
    let geometry: THREE.BufferGeometry
    if (extension === "stl") {
        geometry = new STLLoader().parse(buffer)
    } else if (extension === "obj") {
        geometry = mergedMeshes(new OBJLoader().parse(new TextDecoder().decode(data)))
    } else if (extension === "dae") {
        const collada = new ColladaLoader().parse(new TextDecoder().decode(data), "")
        if (!collada) {
            throw new Error("not a COLLADA file")
        }
        geometry = mergedMeshes(collada.scene)
    } else {
        throw new Error(`unsupported mesh format .${extension}`)
    }
    if (!geometry.attributes.normal) {
        geometry.computeVertexNormals()
    }
    geometry.userData.shared = true
    return geometry
}

const originMatrix = (origin: Origin) =>
    new THREE.Matrix4().compose(
        new THREE.Vector3(...origin.xyz),
        new THREE.Quaternion(...origin.quat),
        new THREE.Vector3(1, 1, 1),
    )

/** Joint positions by URDF joint name. */
export type JointPositions = Record<string, number>

export class Kinematics {
    /** the tree order (parents before children) */
    readonly #order: UrdfJoint[] = []
    readonly #origins = new Map<string, THREE.Matrix4>()
    readonly root: string
    readonly joints: Map<string, UrdfJoint>

    constructor(readonly description: UrdfDescription) {
        this.joints = new Map(description.joints.map((joint) => [joint.name, joint]))
        for (const joint of description.joints) {
            this.#origins.set(joint.name, originMatrix(joint.origin))
        }
        const childLinks = new Set(description.joints.map((joint) => joint.child))
        this.root = description.links.find((link) => !childLinks.has(link.name))?.name ?? description.links[0]?.name ??
            ""
        const visit = (link: string) => {
            for (const joint of description.joints) {
                if (joint.parent === link) {
                    this.#order.push(joint)
                    visit(joint.child)
                }
            }
        }
        visit(this.root)
    }

    /** A joint's position from what's given: its own name, or its mimic source. */
    position(joint: UrdfJoint, positions: JointPositions): number {
        if (joint.mimic) {
            const source = this.joints.get(joint.mimic.joint)
            return source ? this.position(source, positions) * joint.mimic.multiplier + joint.mimic.offset : 0
        }
        return positions[joint.name] ?? 0
    }

    /** Every link's pose relative to the root link. */
    linkPoses(positions: JointPositions): Map<string, THREE.Matrix4> {
        const poses = new Map<string, THREE.Matrix4>([[this.root, new THREE.Matrix4()]])
        const motion = new THREE.Matrix4()
        const axis = new THREE.Vector3()
        for (const joint of this.#order) {
            const parent = poses.get(joint.parent) ?? new THREE.Matrix4()
            const pose = parent.clone().multiply(this.#origins.get(joint.name)!)
            const value = this.position(joint, positions)
            axis.set(...joint.axis).normalize()
            if (joint.type === "revolute" || joint.type === "continuous") {
                pose.multiply(motion.makeRotationAxis(axis, value))
            } else if (joint.type === "prismatic") {
                pose.multiply(motion.makeTranslation(axis.multiplyScalar(value)))
            }
            poses.set(joint.child, pose)
        }
        return poses
    }

    /** Each movable joint's position read back from its child link's pose in its parent's (`relative(child, parent)`, e.g. TF). */
    positionsFrom(relative: (child: string, parent: string) => THREE.Matrix4 | null): JointPositions {
        const positions: JointPositions = {}
        const motion = new THREE.Matrix4()
        const rotation = new THREE.Quaternion()
        const translation = new THREE.Vector3()
        for (const joint of this.joints.values()) {
            if (joint.type !== "revolute" && joint.type !== "continuous" && joint.type !== "prismatic") {
                continue
            }
            const pose = relative(joint.child, joint.parent)
            if (!pose) {
                continue
            }
            motion.copy(this.#origins.get(joint.name)!).invert().multiply(pose)
            const axis = new THREE.Vector3(...joint.axis).normalize()
            if (joint.type === "prismatic") {
                positions[joint.name] = translation.setFromMatrixPosition(motion).dot(axis)
            } else {
                rotation.setFromRotationMatrix(motion)
                positions[joint.name] = 2 *
                    Math.atan2(new THREE.Vector3(rotation.x, rotation.y, rotation.z).dot(axis), rotation.w)
            }
        }
        return positions
    }
}

export type DisplayMode = "visual" | "collision" | "both"

/** The three.js robot: a group per link (named by it), holding its visual and collision meshes. */
export class UrdfModel {
    readonly root = new THREE.Group()
    readonly links = new Map<string, THREE.Group>()
    readonly materials: THREE.MeshStandardMaterial[] = []
    readonly #pending: { group: THREE.Group; kind: "visual" | "collision"; item: UrdfGeometry }[] = []
    readonly #opacity: number
    #display: DisplayMode = "visual"

    constructor(readonly kinematics: Kinematics, geometries: Map<string, THREE.BufferGeometry>, opacity = 1) {
        this.#opacity = opacity
        for (const link of kinematics.description.links) {
            const group = new THREE.Group()
            group.name = link.name
            group.matrixAutoUpdate = false
            for (const [kind, items] of [["visual", link.visuals], ["collision", link.collisions]] as const) {
                for (const item of items) {
                    this.#pending.push({ group, kind, item })
                }
            }
            this.links.set(link.name, group)
            this.root.add(group)
        }
        this.fill(geometries)
    }

    #material(color: THREE.ColorRepresentation, alpha: number) {
        const made = new THREE.MeshStandardMaterial({
            color,
            roughness: 0.55,
            metalness: 0.1,
            transparent: alpha < 1,
            opacity: alpha,
            depthWrite: alpha >= 1,
        })
        this.materials.push(made)
        return made
    }

    #shapeOf(geometry: UrdfGeometry, geometries: Map<string, THREE.BufferGeometry>): THREE.BufferGeometry | null {
        switch (geometry.type) {
            case "mesh":
                return geometry.mesh ? geometries.get(geometry.mesh) ?? null : null
            case "box":
                return new THREE.BoxGeometry(...(geometry.size ?? [0.1, 0.1, 0.1]))
            case "sphere":
                return new THREE.SphereGeometry(geometry.radius ?? 0.05, 24, 16)
            case "cylinder": {
                // URDF cylinders run along z; three's along y
                const cylinder = new THREE.CylinderGeometry(
                    geometry.radius ?? 0.05,
                    geometry.radius ?? 0.05,
                    geometry.length ?? 0.1,
                    24,
                )
                cylinder.rotateX(Math.PI / 2)
                return cylinder
            }
        }
    }

    /** Adds the meshes that have arrived since (a URDF's meshes load one by one); true if any was added. */
    fill(geometries: Map<string, THREE.BufferGeometry>): boolean {
        let added = false
        for (let index = this.#pending.length - 1; index >= 0; index--) {
            const { group, kind, item } = this.#pending[index]
            const shape = this.#shapeOf(item, geometries)
            if (!shape) {
                continue
            }
            this.#pending.splice(index, 1)
            const color = kind === "collision"
                ? "#ff8a3d"
                : item.color
                ? new THREE.Color(item.color[0], item.color[1], item.color[2])
                : "#d9dde3"
            const alpha = kind === "collision" ? Math.min(this.#opacity, 0.45) : this.#opacity * (item.color?.[3] ?? 1)
            const mesh = new THREE.Mesh(shape, this.#material(color, alpha))
            mesh.userData.kind = kind
            mesh.matrixAutoUpdate = false
            mesh.matrix.copy(originMatrix(item.origin))
            if (item.scale) {
                mesh.matrix.scale(new THREE.Vector3(...item.scale))
            }
            mesh.visible = this.#display === "both" || this.#display === kind
            group.add(mesh)
            added = true
        }
        return added
    }

    setDisplay(mode: DisplayMode) {
        this.#display = mode
        this.root.traverse((object) => {
            const kind = object.userData.kind as string | undefined
            if (kind) {
                object.visible = mode === "both" || mode === kind
            }
        })
    }

    dispose() {
        this.root.traverse((object) => {
            const mesh = object as THREE.Mesh
            // mesh geometries are shared by every model built from the recording: their owner disposes them
            if (mesh.isMesh && !mesh.geometry.userData.shared) {
                mesh.geometry.dispose()
            }
        })
        this.materials.forEach((material) => material.dispose())
    }
}

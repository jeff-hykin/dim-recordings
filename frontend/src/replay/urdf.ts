// The three.js robot for a URDF as dimos-react reads it (parseUrdf, Kinematics): a group per link, holding its visual
// and collision meshes, filled in as the recording's meshes arrive.
import * as THREE from "three"
import type { DescriptionGeometry, Kinematics, Origin } from "dimos-react/three"

const originMatrix = (origin: Origin) =>
    new THREE.Matrix4().compose(
        new THREE.Vector3(...origin.xyz),
        new THREE.Quaternion(...origin.quat),
        new THREE.Vector3(1, 1, 1),
    )

export type DisplayMode = "visual" | "collision" | "both"

/** The three.js robot: a group per link (named by it), holding its visual and collision meshes. */
export class UrdfModel {
    readonly root = new THREE.Group()
    readonly links = new Map<string, THREE.Group>()
    readonly materials: THREE.MeshStandardMaterial[] = []
    readonly #pending: { group: THREE.Group; kind: "visual" | "collision"; item: DescriptionGeometry }[] = []
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

    #shapeOf(
        geometry: DescriptionGeometry,
        geometries: Map<string, THREE.BufferGeometry>,
    ): THREE.BufferGeometry | null {
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

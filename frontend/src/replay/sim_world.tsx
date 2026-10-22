// The simulated world a recording of a sim run holds (the Controller's sim scene layer, layers/simScene.tsx): a SceneData
// module's dimos.scene_data.v1 on /scene_data (only sent when asked: dim-controller's recorder asks when it records
// /scene_info), built once; bodies that move (the scripted movers) follow their TF frames, and grassy height fields
// grow blades.
import { useEffect, useRef, useState } from "react"
import * as THREE from "three"
import { useLayer } from "dimos-react/three"
import type { Overview } from "./api.ts"
import { buildScene, type SceneData } from "./sim/sceneData.ts"
import { bladeCount, isSoftwareRenderer, probeRendererName, windTime } from "./sim/grass.ts"

export interface SimSettings {
    opacity: number
    /** geoms that start above this height (m) are left out, so ceilings and upper floors don't hide the robot */
    cutAbove: number
    /** add the world's own lights to the view's */
    lights: boolean
    /** blades on the world's grass height fields */
    grass: boolean
    /** 1 = the default look; lower for a weak GPU */
    grassDensity: number
    /** wind sway: the view keeps redrawing while grass is on screen */
    sway: boolean
}

let gpuName: string | null = null
/** the GPU's name, asked once (a throwaway WebGL context) */
export function gpu(): string {
    gpuName ??= probeRendererName()
    return gpuName
}

// thousands of blades on a CPU renderer would crawl: off there unless this viewer turns it on
export const DEFAULT_SIM: SimSettings = {
    opacity: 1,
    cutAbove: 2.5,
    lights: false,
    grass: true,
    grassDensity: 1,
    sway: true,
}
export const defaultSim = (): SimSettings => ({ ...DEFAULT_SIM, grass: !isSoftwareRenderer(gpu()) })

/** The recording's world: its scene_data stream's latest message, or null when it has none. */
export function useRecordingScene(overview: Overview): { scene: SceneData | null; problem: string | null } {
    const [answer, setAnswer] = useState<{ scene: SceneData | null; problem: string | null }>({
        scene: null,
        problem: null,
    })
    useEffect(() => {
        const stream = overview.streams.find((each) => /(^|\/)scene_data$/.test(each.name) && each.count > 0)
        if (!stream) {
            return
        }
        let gone = false
        fetch(
            `api/replay/${encodeURIComponent(overview.id)}/message?stream=${encodeURIComponent(stream.name)}&t=${
                overview.end - overview.start
            }`,
        )
            .then((response) => (response.ok ? response.json() : null))
            .then((body) => {
                if (gone || typeof body?.message?.data !== "string") {
                    return
                }
                try {
                    const scene = JSON.parse(body.message.data) as SceneData
                    setAnswer(
                        scene.format === "dimos.scene_data.v1"
                            ? { scene, problem: null }
                            : { scene: null, problem: `scene_data is ${scene.format}, not dimos.scene_data.v1` },
                    )
                } catch (error) {
                    setAnswer({ scene: null, problem: `scene_data isn't JSON: ${error}` })
                }
            })
            .catch(() => {})
        return () => {
            gone = true
        }
    }, [overview])
    return answer
}

/** a geom's lowest point in world coordinates (its body's pose included), to cut ceilings by */
function lowestZ(mesh: THREE.Mesh): number {
    mesh.geometry.computeBoundingBox()
    const body = mesh.parent!
    body.updateMatrix()
    mesh.updateMatrix()
    const inWorld = new THREE.Matrix4().multiplyMatrices(body.matrix, mesh.matrix)
    return new THREE.Box3().copy(mesh.geometry.boundingBox!).applyMatrix4(inWorld).min.z
}

function disposeTree(object: THREE.Object3D) {
    object.traverse((child) => {
        const mesh = child as THREE.Mesh
        mesh.geometry?.dispose()
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined
        if (Array.isArray(material)) {
            material.forEach((item) => item.dispose())
        } else {
            material?.dispose()
        }
    })
}

export function SimWorld({ scene: data, settings }: { scene: SceneData; settings: SimSettings }) {
    const current = useRef(settings)
    current.current = settings
    const layer = useLayer(({ viewer, tf }) => {
        const scene = buildScene(data)
        // scene coordinates are the world frame; the root is re-placed in the view's fixed frame every frame
        const root = new THREE.Group()
        root.matrixAutoUpdate = false
        root.add(scene.root)
        const apply = () => {
            const { opacity, cutAbove, lights, grass, grassDensity } = current.current
            scene.root.traverse((object) => {
                const mesh = object as THREE.Mesh
                if (!mesh.isMesh || mesh.userData.grass) {
                    return
                }
                const material = mesh.material as THREE.MeshStandardMaterial
                const alpha = (mesh.userData.baseOpacity as number) * opacity
                material.opacity = alpha
                material.transparent = alpha < 1
                material.depthWrite = alpha >= 1
                mesh.visible = lowestZ(mesh) <= cutAbove
            })
            for (const light of scene.lights) {
                light.visible = lights
            }
            for (const blades of scene.grass) {
                blades.mesh.count = Math.min(blades.mesh.instanceMatrix.count, bladeCount(blades.area, grassDensity))
                blades.mesh.visible = grass && blades.mesh.count > 0
            }
            viewer.requestRender()
        }
        apply()
        return {
            root,
            apply,
            update(frame: { fixedFrame: string; now: number }) {
                // the wind: only while grass is shown and swaying, since it keeps the view redrawing
                const { grass, sway } = current.current
                if (grass && sway && scene.grass.some((field) => field.mesh.visible)) {
                    windTime.value = frame.now / 1000
                    viewer.requestRender()
                }
                const world = tf.lookup("world", frame.fixedFrame)
                root.visible = !!world
                if (world && !root.matrix.equals(world)) {
                    root.matrix.copy(world)
                    root.matrixWorldNeedsUpdate = true
                    viewer.requestRender()
                }
                // movers: their TF frame (world -> body) wins over the pose they started at
                for (const [name, group] of scene.bodies) {
                    if (!group.userData.mocap) {
                        continue
                    }
                    const pose = tf.lookup(name, "world")
                    if (pose) {
                        const before = group.position.clone()
                        pose.decompose(group.position, group.quaternion, group.scale)
                        if (!before.equals(group.position)) {
                            viewer.requestRender()
                        }
                    }
                }
            },
            dispose() {
                disposeTree(scene.root)
            },
        }
    }, [data])
    useEffect(() => layer.current?.apply(), [layer, settings])
    return null
}

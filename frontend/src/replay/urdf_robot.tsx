// The robot drawn from the recording's URDF (the Controller's robot model layer, layers/robotModel.tsx): each link at
// its TF frame (UrdfManager puts every joint on TF, frames named by link), its visuals at their URDF origins; a link
// with no TF frame follows its parent through the joint's origin. Meshes fill in as they load.
import { useEffect, useRef } from "react"
import * as THREE from "three"
import { useLayer } from "dimos-react/three"
import { type DisplayMode, Kinematics, UrdfModel } from "./urdf.ts"
import type { RecordingUrdf } from "./use_urdf.ts"

export function UrdfRobot({ urdf, display, opacity, onPlaced }: {
    urdf: RecordingUrdf
    display: DisplayMode
    opacity: number
    /** whether its root link could be placed in the fixed frame (false: no TF path to it) */
    onPlaced?: (placed: boolean) => void
}) {
    const { description, geometries, meshVersion } = urdf
    const placedRef = useRef(onPlaced)
    placedRef.current = onPlaced
    const layer = useLayer(({ viewer, tf }) => {
        if (!description) {
            return null
        }
        const kinematics = new Kinematics(description)
        const model = new UrdfModel(kinematics, geometries, opacity)
        model.setDisplay(display)
        const root = new THREE.Group()
        root.matrixAutoUpdate = false
        root.add(model.root)
        let tfVersion = -1
        let fixedFrame = ""
        let placedBefore: boolean | null = null
        return {
            root,
            /** meshes loaded since: add them, and pose again */
            fill() {
                if (model.fill(geometries)) {
                    tfVersion = -1
                    viewer.requestRender()
                }
            },
            update(frame: { fixedFrame: string }) {
                const placed = tf.lookup(kinematics.root, frame.fixedFrame)
                if (!!placed !== placedBefore) {
                    placedBefore = !!placed
                    root.visible = !!placed
                    placedRef.current?.(!!placed)
                    viewer.requestRender()
                }
                // only when the tree moved
                if (!placed || (tf.version === tfVersion && frame.fixedFrame === fixedFrame)) {
                    return
                }
                tfVersion = tf.version
                fixedFrame = frame.fixedFrame
                // every link at its TF frame; one without a frame at its parent's through the joint's origin (parents come first)
                const inFixed = (link: string) => tf.lookup(link, frame.fixedFrame)
                const relative = (child: string, parent: string) => {
                    const childPose = inFixed(child), parentPose = inFixed(parent)
                    return childPose && parentPose ? parentPose.clone().invert().multiply(childPose) : null
                }
                for (const [link, pose] of kinematics.linkPoses(kinematics.positionsFrom(relative))) {
                    const group = model.links.get(link)
                    if (!group) {
                        continue
                    }
                    const at = inFixed(link) ?? placed.clone().multiply(pose)
                    if (!group.matrix.equals(at)) {
                        group.matrix.copy(at)
                        group.matrixWorldNeedsUpdate = true
                    }
                }
                viewer.requestRender()
            },
            dispose() {
                model.dispose()
            },
        }
    }, [description, geometries, display, opacity])
    // a mesh loaded: the live model adds it (no rebuild)
    useEffect(() => layer.current?.fill(), [layer, meshVersion])
    return null
}

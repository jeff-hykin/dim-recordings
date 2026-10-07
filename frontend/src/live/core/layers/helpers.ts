// Shared bits for layer files: placing by TF, decoding raw subscriptions, colors.
import * as THREE from "three"
import { decode, type LcmValue } from "../lcm/lcm.ts"
import type { LayerContext } from "./registry.ts"
import type { Topic } from "../transport.ts"

/**
 * Sets `object.matrix` to T_fixed_frame and shows it; with no TF path it hides the object and reports why.
 * Returns whether it could be placed.
 */
export function placeInFixedFrame(
    context: LayerContext,
    object: THREE.Object3D,
    frame: string,
    fixedFrame: string,
): boolean {
    const matrix = context.tf.lookup(frame, fixedFrame)
    if (!matrix) {
        if (object.visible) {
            object.visible = false
            context.viewer.requestRender()
        }
        context.setStatus({
            problem: `no TF path from "${frame}" to "${fixedFrame}"`,
        })
        return false
    }
    if (!object.visible || !object.matrix.equals(matrix)) {
        object.matrix.copy(matrix)
        object.matrixWorldNeedsUpdate = true
        object.visible = true
        context.viewer.requestRender()
    }
    context.setStatus({
        problem: frame === "" ? "no frame_id: drawn in the fixed frame" : null,
    })
    return true
}

/** Subscribes to a topic's raw bytes and hands each decoded message (plus the gateway timestamp) to `onMessage`. */
export function subscribeDecoded(
    context: LayerContext,
    topic: Topic,
    options: { maxHz?: number; reliable?: boolean; decodeAs?: string },
    onMessage: (message: LcmValue, timestamp: number) => void,
): () => void {
    let failures = 0
    return context.connection.subscribe(topic.key, {
        delivery: options.reliable ? "reliable" : "latest",
        maxHz: options.maxHz ?? 30,
    }, (message) => {
        let decoded
        try {
            decoded = decode(options.decodeAs ?? topic.type, message.bytes)
        } catch (error) {
            failures++
            context.setStatus({
                problem: `cannot decode ${topic.type} (${failures}×): ${error}`,
            })
            return
        }
        onMessage(decoded, message.timestamp)
    })
}

/** A geometry_msgs Pose (position + orientation) as a Matrix4. */
export function poseMatrix(
    pose: LcmValue,
    out = new THREE.Matrix4(),
): THREE.Matrix4 {
    const position = pose?.position ?? {}
    const orientation = pose?.orientation ?? {}
    const quaternion = new THREE.Quaternion(
        orientation.x ?? 0,
        orientation.y ?? 0,
        orientation.z ?? 0,
        orientation.w ?? 1,
    )
    if (quaternion.lengthSq() < 1e-12) {
        quaternion.set(0, 0, 0, 1)
    }
    return out.compose(
        new THREE.Vector3(position.x ?? 0, position.y ?? 0, position.z ?? 0),
        quaternion.normalize(),
        new THREE.Vector3(1, 1, 1),
    )
}

/** std_msgs ColorRGBA → THREE.Color + alpha. */
export function rgba(color: LcmValue): { color: THREE.Color; alpha: number } {
    return {
        color: new THREE.Color(color?.r ?? 1, color?.g ?? 1, color?.b ?? 1),
        alpha: color?.a ?? 1,
    }
}

/** A stable, distinct color per name (for paths, robots, boxes of one class). */
export function colorFor(name: string): THREE.Color {
    let hash = 0
    for (const char of name) {
        hash = (hash * 31 + char.charCodeAt(0)) | 0
    }
    return new THREE.Color().setHSL(((hash >>> 0) % 360) / 360, 0.75, 0.6)
}

/** Disposes geometries and materials under an object. */
export function disposeTree(object: THREE.Object3D) {
    object.traverse((child) => {
        const mesh = child as THREE.Mesh
        mesh.geometry?.dispose()
        const material = mesh.material as
            | THREE.Material
            | THREE.Material[]
            | undefined
        if (Array.isArray(material)) {
            material.forEach((item) => item.dispose())
        } else {
            material?.dispose()
        }
    })
    object.removeFromParent()
}

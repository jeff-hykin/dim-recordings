// vision_msgs.Detection2DArray / Detection2D / BoundingBox2DArray over a camera panel: a box and "class score" per
// detection, in the image's pixel coordinates.
import { registerOverlay } from "../core/layers/registry.ts"
import { colorFor } from "../core/layers/helpers.ts"
import type { LcmValue } from "../core/lcm/lcm.ts"

registerOverlay({
    id: "detection2d",
    label: "2D detections",
    types: [
        "vision_msgs.Detection2DArray",
        "vision_msgs.Detection2D",
        "vision_msgs.BoundingBox2DArray",
    ],
    draw(context, message: LcmValue) {
        const boxes = message.detections ??
            message.boxes?.map((bbox: LcmValue) => ({ bbox })) ?? [message]
        context.lineWidth = Math.max(2, context.canvas.width / 400)
        context.font = `${Math.max(12, context.canvas.width / 60)}px ui-sans-serif, system-ui`
        context.textBaseline = "bottom"
        for (const detection of boxes) {
            const box = detection.bbox ?? {}
            const center = box.center?.position ?? { x: 0, y: 0 }
            const left = center.x - (box.size_x ?? 0) / 2
            const top = center.y - (box.size_y ?? 0) / 2
            const best = [...(detection.results ?? [])].sort((a: LcmValue, b: LcmValue) =>
                (b.hypothesis?.score ?? 0) - (a.hypothesis?.score ?? 0)
            )[0]
            const name = best?.hypothesis?.class_id || detection.id || ""
            const color = `#${colorFor(name || "box").getHexString()}`
            context.strokeStyle = color
            context.strokeRect(left, top, box.size_x ?? 0, box.size_y ?? 0)
            if (name) {
                const text = best?.hypothesis?.score !== undefined
                    ? `${name} ${(best.hypothesis.score * 100).toFixed(0)}%`
                    : name
                const width = context.measureText(text).width + 8
                const height = parseFloat(context.font) + 4
                context.fillStyle = color
                context.fillRect(left, top - height, width, height)
                context.fillStyle = "#0b0f14"
                context.fillText(text, left + 4, top - 2)
            }
        }
    },
})

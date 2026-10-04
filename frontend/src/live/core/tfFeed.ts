// Keeps the TF tree fed: every tf2_msgs.TFMessage topic on the bridge, always (the tf layer only draws it).
// A topic named like tf_static is treated as static (exempt from staleness).
import { decode } from "./lcm/lcm.ts"
import type { Connection } from "./transport.ts"
import type { TfTree } from "./tf.ts"
import type { Viewer } from "./render/viewer.ts"

export function feedTf(connection: Connection, tf: TfTree, viewer: Viewer) {
    const subscribed = new Set<string>()
    const sync = () => {
        for (const topic of connection.status.get().topics) {
            if (topic.type !== "tf2_msgs.TFMessage" || subscribed.has(topic.key)) {
                continue
            }
            subscribed.add(topic.key)
            const isStatic = /static/i.test(topic.name)
            // reliable: one tf topic often carries different edges from different publishers, so none may be dropped
            connection.subscribe(topic.key, { delivery: "reliable" }, (message) => {
                let decoded
                try {
                    decoded = decode("tf2_msgs.TFMessage", message.bytes)
                } catch {
                    return
                }
                for (const stamped of decoded.transforms ?? []) {
                    const { translation, rotation } = stamped.transform ?? {}
                    if (!translation || !rotation) {
                        continue
                    }
                    tf.set(
                        stamped.header?.frame_id ?? "",
                        stamped.child_frame_id ?? "",
                        [translation.x, translation.y, translation.z],
                        [rotation.x, rotation.y, rotation.z, rotation.w],
                        isStatic,
                    )
                }
                viewer.noteData(message.timestamp)
            })
        }
    }
    connection.status.subscribe(sync)
    sync()
}

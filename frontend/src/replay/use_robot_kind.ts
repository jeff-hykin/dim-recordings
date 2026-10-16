// The Replayer's robot: recordingRobotKind over the recording's URDF (its urdf_info stream's latest message, asked for
// once), the TF frames seen so far and its file name. Once identified it stays (a seek clears the TF tree for a moment).
import { useEffect, useState } from "react"
import type { Overview } from "./api.ts"
import { recordingRobotKind, type RobotKindAnswer } from "./robot_kind.ts"

export function useRecordingRobot(
    overview: Overview,
    tf: { frames(): string[]; onChange(listener: () => void): () => void },
): RobotKindAnswer | null {
    const [urdf, setUrdf] = useState<string | null>(null)
    const [answer, setAnswer] = useState<RobotKindAnswer | null>(() =>
        recordingRobotKind({ frames: [], name: overview.name })
    )
    useEffect(() => {
        const stream = overview.streams.find((each) => /(^|\/)urdf_info$/.test(each.name) && each.count > 0)
        if (!stream) {
            return
        }
        let gone = false
        const url = `api/replay/${encodeURIComponent(overview.id)}/message?stream=${
            encodeURIComponent(stream.name)
        }&t=${overview.end - overview.start}`
        fetch(url)
            .then((response) => (response.ok ? response.json() : null))
            .then((body) =>
                !gone && typeof body?.message?.data === "string" &&
                setUrdf(body.message.data)
            )
            .catch(() => {})
        return () => {
            gone = true
        }
    }, [overview])
    useEffect(() => {
        const check = () => {
            const next = recordingRobotKind({
                urdf,
                frames: tf.frames(),
                name: overview.name,
            })
            // a cleared tree (a seek) says nothing: keep what was found; TF changes many times a second, so set only news
            setAnswer((old) => (next && next.reason !== old?.reason ? next : old))
        }
        check()
        return tf.onChange(check)
    }, [tf, urdf, overview.name])
    return answer
}

// A recording's preview: 15 frames from its start, middle and end in one sprite, played while on screen and scrubbed
// by the pointer's x; a recording with no camera shows its odometry path from above. (App-specific: the sprite format
// is this app's backend's.)
import { useEffect, useRef, useState } from "react"
import { Icon } from "dimos-react"
import { api, type Thumb } from "../api.ts"

/** "12 m", "1.4 km" */
export function metres(value: number) {
    return value >= 1000 ? `${(value / 1000).toFixed(1)} km` : `${value < 10 ? value.toFixed(1) : Math.round(value)} m`
}

/** A recording with no camera: its odometry path from above (start dot, end ring), in the theme's colors. */
export function PathThumbnail(
    { thumb }: { thumb: Extract<Thumb, { state: "path" }> },
) {
    // the unit box drawn into a 16:9 frame with a margin; svg y runs down, the path's y runs up
    const [w, h, pad] = [160, 90, 9]
    const side = Math.min(w, h) - 2 * pad
    const [ox, oy] = [(w - side) / 2, (h - side) / 2]
    const at = ([x, y]: [number, number]) => [ox + x * side, oy + (1 - y) * side] as const
    const line = thumb.points.map((p, i) => `${i ? "L" : "M"}${at(p).map((v) => v.toFixed(1)).join(" ")}`).join("")
    const [sx, sy] = at(thumb.points[0])
    const [ex, ey] = at(thumb.points[thumb.points.length - 1])
    return (
        <div
            className="rec-thumb rec-path-thumb"
            title={`${thumb.stream}: ${metres(thumb.length)} of path, ${metres(thumb.width)} × ${
                metres(thumb.height)
            } (no camera: the odometry from above)`}
        >
            <svg
                viewBox={`0 0 ${w} ${h}`}
                preserveAspectRatio="xMidYMid meet"
                aria-label="odometry path from above"
            >
                <rect
                    x={ox}
                    y={oy}
                    width={side}
                    height={side}
                    className="rec-path-frame"
                />
                <path d={line} className="rec-path-line" />
                <circle cx={sx} cy={sy} r="3.2" className="rec-path-start" />
                <circle cx={ex} cy={ey} r="3.4" className="rec-path-end" />
            </svg>
            <span className="rec-path-scale">
                {metres(Math.max(thumb.width, thumb.height))}
            </span>
        </div>
    )
}

export function Thumbnail(
    { id, thumb, version, src }: {
        id: string
        thumb: Thumb
        version: number
        src?: string
    },
) {
    const box = useRef<HTMLDivElement>(null)
    const [frame, setFrame] = useState(0)
    const [visible, setVisible] = useState(false)
    const [scrubbing, setScrubbing] = useState(false)
    const frames = thumb.state === "ready" ? thumb.frames : 0
    const url = src ?? api.thumbnailUrl(id, version)
    useEffect(() => {
        if (!box.current) {
            return
        }
        const observer = new IntersectionObserver(
            ([entry]) => setVisible(entry.isIntersecting),
            { threshold: 0.4 },
        )
        observer.observe(box.current)
        return () => observer.disconnect()
    }, [])
    useEffect(() => {
        if (!frames || !visible || scrubbing) {
            return
        }
        const timer = setInterval(
            () => setFrame((current) => (current + 1) % frames),
            420,
        )
        return () => clearInterval(timer)
    }, [frames, visible, scrubbing])
    if (thumb.state === "path") {
        return <PathThumbnail thumb={thumb} />
    }
    if (thumb.state !== "ready") {
        return (
            <div
                ref={box}
                className="rec-thumb rec-thumb-placeholder"
                title={thumb.state === "none" ? thumb.reason : "making a preview…"}
            >
                <Icon name="camera" size={18} />
                <span>{thumb.state === "none" ? "no preview" : "preview…"}</span>
            </div>
        )
    }
    return (
        <div
            ref={box}
            className="rec-thumb"
            data-frame={frame}
            style={{
                backgroundImage: `url(${url})`,
                backgroundSize: `${frames * 100}% auto`,
                backgroundPositionY: "center",
                backgroundPositionX: `${frames > 1 ? (frame / (frames - 1)) * 100 : 0}%`,
            }}
            title={`${thumb.stream} · start, middle, end`}
            onPointerMove={(event) => {
                const rect = event.currentTarget.getBoundingClientRect()
                setScrubbing(true)
                setFrame(
                    Math.min(
                        frames - 1,
                        Math.max(
                            0,
                            Math.floor(((event.clientX - rect.left) / rect.width) * frames),
                        ),
                    ),
                )
            }}
            onPointerLeave={() => setScrubbing(false)}
        >
            <span
                className="rec-thumb-bar"
                style={{ width: `${((frame + 1) / frames) * 100}%` }}
            />
        </div>
    )
}

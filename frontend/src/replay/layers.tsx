// What the Replayer draws for each stream: dimos-react's layers, picked by message type (app composition only; the
// drawing is the library's). A pose stream shows its pose and its whole route (read once from the file), so the
// route is there from the first frame and survives every seek.
import { useEffect, useState } from "react"
import { Path, PointCloud, Pose, PoseArray, RobotModel, TfFeed, TfFrames } from "dimos-react/three"
import { dimosKey } from "dimos-react"
import { type Overview, replayApi } from "./api.ts"
import { isDepthStream, type StreamInfo } from "./source.ts"

export interface PointLook {
    style: "voxel" | "splat" | "disc" | "square"
    size: number
    colorMode: "height" | "intensity" | "range" | "solid"
    gradient: string
}

export interface ReplaySettings {
    /** "" = the TF tree's world-ish root */
    fixedFrame: string
    follow: boolean
    /** "" = base_link */
    followFrame: string
    robotModel: boolean
    robotKind: string
    showStats: boolean
    frameNames: boolean
    /** per point-cloud stream (its key) */
    looks: Record<string, Partial<PointLook>>
}

export const DEFAULT_SETTINGS: ReplaySettings = {
    fixedFrame: "",
    follow: true,
    followFrame: "",
    robotModel: true,
    robotKind: "dog",
    showStats: false,
    frameNames: true,
    looks: {},
}

export const DEFAULT_LOOK: PointLook = {
    style: "voxel",
    size: 0.05,
    colorMode: "height",
    gradient: "memworld",
}

/** A map-like cloud (accumulated by its publisher): bigger points by default. */
const isMapStream = (name: string) => /map|global/i.test(name)

export function lookFor(
    settings: ReplaySettings,
    stream: StreamInfo,
): PointLook {
    const key = dimosKey(stream.name, stream.type)
    return {
        ...DEFAULT_LOOK,
        ...(isMapStream(stream.name) ? { size: 0.08 } : {}),
        ...settings.looks[key],
    }
}

/** What a stream is drawn as in 3D (null: not in 3D; cameras get panels). */
export function layerKind(
    type: string,
): "cloud" | "pose" | "path" | "poses" | "tf" | null {
    if (type === "sensor_msgs.PointCloud2") {
        return "cloud"
    }
    if (
        /^(nav_msgs\.Odometry|geometry_msgs\.(PoseStamped|PoseWithCovarianceStamped))$/
            .test(type)
    ) {
        return "pose"
    }
    if (type === "nav_msgs.Path") {
        return "path"
    }
    if (type === "geometry_msgs.PoseArray") {
        return "poses"
    }
    if (type === "tf2_msgs.TFMessage") {
        return "tf"
    }
    return null
}

/** Whether a stream gets a 3D layer or a camera panel (the timeline's draw switch). */
export function drawable(stream: StreamInfo) {
    return layerKind(stream.type) !== null || /Image$/.test(stream.type)
}

// routes already read this session (each read decodes a few hundred messages: seconds on a big file)
const routes = new Map<
    string,
    Promise<{ frame: string; points: [number, number, number][] }>
>()

/** A pose stream's whole route, read once from the file. */
export function useRoute(id: string, stream: string) {
    const [route, setRoute] = useState<
        { frame: string; points: [number, number, number][] } | null
    >(null)
    useEffect(() => {
        let live = true
        const key = `${id}\n${stream}`
        if (!routes.has(key)) {
            routes.set(
                key,
                replayApi.path(id, stream).then((path) => ({
                    frame: path.frame,
                    points: path.points.map(([, x, y, z]) => [x, y, z] as [number, number, number]),
                })),
            )
        }
        routes.get(key)!.then(
            (value) => live && setRoute(value),
            () => routes.delete(key),
        )
        return () => {
            live = false
        }
    }, [id, stream])
    return route
}

function PoseLayer({ id, stream }: { id: string; stream: StreamInfo }) {
    const route = useRoute(id, stream.name)
    const key = dimosKey(stream.name, stream.type)
    return (
        <>
            <Pose topic={key} axesSize={0.5} />
            {route && route.points.length > 1 && (
                <Path
                    poses={route.points}
                    frame={route.frame}
                    color="var(--primary)"
                    width={3}
                    onTop
                />
            )}
        </>
    )
}

/** Forgets the routes read this session (a stream edit changes them). */
export function forgetRoutes() {
    routes.clear()
}

export function ReplayLayers({ overview, settings, hidden, epoch }: {
    overview: Overview
    settings: ReplaySettings
    hidden: Record<string, boolean>
    /** bumped on every jump: the layers that keep history start over */
    epoch: number
}) {
    const streams = overview.streams.filter((stream) => stream.count > 0)
    const shown = (stream: StreamInfo) => !hidden[dimosKey(stream.name, stream.type)]
    const tfShown = streams.some((stream) => layerKind(stream.type) === "tf" && shown(stream))
    return (
        <>
            <TfFeed />
            {tfShown && <TfFrames axesSize={0.25} names={settings.frameNames} />}
            {settings.robotModel && (
                <RobotModel
                    kind={settings.robotKind}
                    frame={settings.followFrame || "base_link"}
                />
            )}
            {streams.filter(shown).map((stream) => {
                const key = dimosKey(stream.name, stream.type)
                const kind = layerKind(stream.type)
                if (kind === "cloud" && !isDepthStream(stream.name)) {
                    const look = lookFor(settings, stream)
                    return (
                        <PointCloud
                            key={`${key}#${epoch}`}
                            topic={key}
                            style={look.style}
                            size={look.size}
                            colorMode={look.colorMode}
                            gradient={look.gradient}
                        />
                    )
                }
                if (kind === "pose") {
                    return <PoseLayer key={key} id={overview.id} stream={stream} />
                }
                if (kind === "path") {
                    return <Path key={key} topic={key} color="var(--ok)" />
                }
                if (kind === "poses") {
                    return <PoseArray key={key} topic={key} />
                }
                return null
            })}
        </>
    )
}

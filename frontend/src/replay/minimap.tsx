// The top-down minimap over the 3D view (the Controller's map panel, through dimos-react's Map2D): the recording's
// lidar map (an accumulated cloud as a height heatmap, /global_map first) with its costmap laid over it, else a costmap
// alone, following the robot.
import type { Topic } from "dimos-react"
import { Map2D, type TfTree } from "dimos-react/three"

const isGrid = (topic: Topic) => topic.type === "nav_msgs.OccupancyGrid"
const isCloud = (topic: Topic) => topic.type === "sensor_msgs.PointCloud2"

/** an accumulated cloud map first, other map clouds, single scans, then occupancy grids (the Controller's core/map2d.ts) */
const rank = (topic: Topic) =>
    isCloud(topic)
        ? (/(^|\/)global_map$/.test(topic.name) ? 0 : /map|global|voxel/i.test(topic.name) ? 1 : 2)
        : 10 + (/(^|\/)map$/.test(topic.name) ? 0 : /global/.test(topic.name) ? 1 : /map/.test(topic.name) ? 2 : 3)

const best = (topics: Topic[], keep: (topic: Topic) => boolean) =>
    topics.filter(keep).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))

/** The map's base candidates (clouds, then grids), best first, and the costmap to lay over a cloud. */
export function mapTopics(topics: Topic[]): { bases: Topic[]; overlay: Topic | null } {
    return { bases: best(topics, (topic) => isCloud(topic) || isGrid(topic)), overlay: best(topics, isGrid)[0] ?? null }
}

export function Minimap({ tf, topics, base, followFrame, fixedFrame }: {
    tf: TfTree
    topics: Topic[]
    /** a topic key; "" picks the best */
    base: string
    followFrame: string
    fixedFrame?: string
}) {
    const { bases, overlay } = mapTopics(topics)
    const topic = bases.find((each) => each.key === base) ?? bases[0] ?? null
    // Map2D fills its positioned parent
    return (
        <div className="rp-minimap" data-testid="replay-minimap">
            <Map2D
                tf={tf}
                topic={topic}
                overlay={topic && isCloud(topic) ? overlay : null}
                followFrame={followFrame}
                fixedFrame={fixedFrame}
            />
        </div>
    )
}

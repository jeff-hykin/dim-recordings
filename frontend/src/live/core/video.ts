// Camera streams, shared: a panel and the 3D projection of the same topic use one subscription. The live Controller
// gets an H.264 track from the bridge; the Replayer gets frames from the backend (a jpeg/png as recorded, or raw
// pixels), drawn into one canvas per topic that panels copy and the 3D view uses as a texture. While scrubbing the
// frames are thumbnails (`quality: "low"`); playing or paused they're full resolution. Depth arrives as raw 16UC1 /
// 32FC1 and is colorized by the panel / the 3D view (render/depth.ts), as in the Controller.
import { Store } from "./store.ts"
import type { Connection, Topic } from "./transport.ts"

export interface VideoState {
    /** the topic's canvas (null until the first frame) */
    canvas: HTMLCanvasElement | null
    /** the frame's own size (a thumbnail is smaller than the camera) */
    width: number
    height: number
    /** frames drawn in the last second */
    fps: number
    quality: "low" | "full"
    /** bumps on every drawn frame */
    version: number
    /** recording time of the frame on show (ms) */
    timestamp: number
}

export interface DepthImage {
    width: number
    height: number
    encoding: string
    data: Uint16Array | Float32Array | Uint8Array
}

export interface Frame {
    kind: "image" | "depth"
    width: number
    height: number
    encoding: string
    frame: string
    data: Uint8Array
}

export const isDepthTopic = (topic: Topic) => /depth/i.test(topic.name)

interface Source {
    users: number
    stop: () => void
    video: Store<VideoState>
    depth: Store<{ image: DepthImage | null; quality: "low" | "full" }>
    canvas: HTMLCanvasElement
}

export class VideoSources {
    #sources = new Map<string, Source>()
    constructor(readonly connection: Connection) {}

    acquire(topic: Topic): Source {
        let source = this.#sources.get(topic.key)
        if (source) {
            source.users++
            return source
        }
        const video = new Store<VideoState>({
            canvas: null,
            width: 0,
            height: 0,
            fps: 0,
            quality: "full",
            version: 0,
            timestamp: 0,
        })
        const depth = new Store<
            { image: DepthImage | null; quality: "low" | "full" }
        >({ image: null, quality: "full" })
        const canvas = document.createElement("canvas")
        let frames = 0
        let since = performance.now()
        let fps = 0
        // frames decode asynchronously (jpeg): a slower older one must not replace a newer one
        let newest = 0
        let ticket = 0
        const stop = this.connection.subscribe(topic.key, {
            delivery: "latest",
            codec: isDepthTopic(topic) ? "dimos-depth" : "dimos-image",
        }, async (message) => {
            const frame = message.decoded as Frame | undefined
            if (!frame) {
                return
            }
            const quality = message.quality ?? "full"
            if (frame.kind === "depth") {
                depth.set({ image: toDepth(frame), quality })
                return
            }
            const mine = ++ticket
            const image = await toDrawable(frame)
            if (!image || mine < newest) {
                return
            }
            newest = mine
            if (canvas.width !== image.width || canvas.height !== image.height) {
                canvas.width = image.width
                canvas.height = image.height
            }
            const context = canvas.getContext("2d")!
            if (image instanceof ImageData) {
                context.putImageData(image, 0, 0)
            } else {
                context.drawImage(image, 0, 0)
                image.close()
            }
            frames++
            const now = performance.now()
            if (now - since > 1000) {
                fps = Math.round((frames * 1000) / (now - since))
                frames = 0
                since = now
            }
            const state = video.get()
            video.set({
                canvas,
                width: canvas.width,
                height: canvas.height,
                fps,
                quality,
                version: state.version + 1,
                timestamp: message.timestamp,
            })
        })
        source = { users: 1, stop, video, depth, canvas }
        this.#sources.set(topic.key, source)
        return source
    }

    release(topic: Topic) {
        const source = this.#sources.get(topic.key)
        if (!source || --source.users > 0) {
            return
        }
        source.stop()
        this.#sources.delete(topic.key)
    }
}

/** An encoded frame → ImageBitmap; raw pixels → ImageData (RGBA). */
async function toDrawable(
    frame: Frame,
): Promise<ImageBitmap | ImageData | null> {
    if (["jpeg", "png", "webp"].includes(frame.encoding)) {
        try {
            return await createImageBitmap(
                new Blob([frame.data as Uint8Array<ArrayBuffer>], {
                    type: `image/${frame.encoding}`,
                }),
            )
        } catch {
            return null
        }
    }
    const { width, height, data } = frame
    if (!width || !height) {
        return null
    }
    const out = new ImageData(width, height)
    const pixels = out.data
    const count = width * height
    const stride = Math.floor(data.byteLength / height)
    const bpp = {
        mono8: 1,
        "8uc1": 1,
        rgb8: 3,
        bgr8: 3,
        rgba8: 4,
        bgra8: 4,
    }[frame.encoding] ?? 0
    if (!bpp) {
        return null
    }
    for (let i = 0; i < count; i++) {
        const row = Math.floor(i / width)
        const at = row * stride + (i - row * width) * bpp
        const o = i * 4
        if (bpp === 1) {
            pixels[o] = pixels[o + 1] = pixels[o + 2] = data[at]
        } else if (frame.encoding.startsWith("bgr")) {
            pixels[o] = data[at + 2]
            pixels[o + 1] = data[at + 1]
            pixels[o + 2] = data[at]
        } else {
            pixels[o] = data[at]
            pixels[o + 1] = data[at + 1]
            pixels[o + 2] = data[at + 2]
        }
        pixels[o + 3] = 255
    }
    return out
}

function toDepth(frame: Frame): DepthImage {
    const { data } = frame
    // copy into an aligned buffer (the payload is already aligned, but a copy keeps the depth image independent)
    const copy = data.slice().buffer
    if (frame.encoding === "32FC1") {
        return {
            width: frame.width,
            height: frame.height,
            encoding: "32FC1",
            data: new Float32Array(copy, 0, Math.floor(data.byteLength / 4)),
        }
    }
    return {
        width: frame.width,
        height: frame.height,
        encoding: "16UC1",
        data: new Uint16Array(copy, 0, Math.floor(data.byteLength / 2)),
    }
}

/** The CameraInfo topic for an image topic: the one sharing the longest leading part of the name. */
export function cameraInfoFor(
    image: Topic,
    topics: Topic[],
    overrides: Record<string, string> = {},
): Topic | null {
    const infos = topics.filter((topic) => topic.type === "sensor_msgs.CameraInfo")
    const wanted = overrides[image.name]
    if (wanted) {
        return infos.find((topic) => topic.name === wanted) ?? null
    }
    const parts = image.name.split("/")
    let best: Topic | null = null
    let bestScore = -1
    for (const info of infos) {
        const other = info.name.split("/")
        let shared = 0
        while (
            shared < Math.min(parts.length, other.length) - 1 &&
            parts[shared] === other[shared]
        ) {
            shared++
        }
        // "color" in both names breaks ties (color_image ↔ color_camera_info over depth_camera_info)
        const score = shared * 10 +
            (/color|rgb/i.test(image.name) === /color|rgb/i.test(info.name) ? 1 : 0)
        if (score > bestScore) {
            best = info
            bestScore = score
        }
    }
    return best
}

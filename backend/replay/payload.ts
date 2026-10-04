// A stored message → what the page draws. The page's layers are the Controller's, which read dimos LCM; so a .db blob
// goes out as its LCM bytes (lz4 unwrapped), a CDR .mcap message is re-encoded as LCM, and the two heavy kinds go out
// pre-digested: images as the encoded frame (jpeg/png) or raw pixels, point clouds as float32 xyz + u8 intensity
// (what the bridge's dimos-pointcloud2 codec gives the live view), each in a full and a low ("thumbnail") quality.
import { cdrReader, unwrapBlob } from "../recordings/messages.ts"
import { decode as lcmDecode, encode as lcmEncode, schemas } from "./lcm.ts"
import type { StreamMeta } from "./source.ts"

export type Quality = "low" | "full"

/** Longest side of a low-quality (scrubbing) raw image. */
export const LOW_IMAGE_SIDE = 192
/** Most points in a low-quality (scrubbing) cloud. */
export const LOW_CLOUD_POINTS = 6000

// deno-lint-ignore no-explicit-any
type Any = any

/** The message as a JS object: LCM-decoded (dimos names) or CDR-decoded (ROS 2 names); null when unreadable. */
export function decodeObject(meta: StreamMeta, raw: Uint8Array): Any | null {
    try {
        if (meta.encoding === "cdr") {
            return cdrReader(meta.schemaName ?? "", meta.schemaText ?? "")
                .readMessage(raw)
        }
        if (meta.encoding === "json") {
            return JSON.parse(new TextDecoder().decode(raw))
        }
        return lcmDecode(meta.type, unwrapBlob(raw))
    } catch {
        return null
    }
}

/** The message as dimos LCM bytes (what the Controller's layers decode), or null when its type has no LCM schema. */
export function toLcm(meta: StreamMeta, raw: Uint8Array): Uint8Array | null {
    if (meta.encoding !== "cdr" && meta.encoding !== "json") {
        return unwrapBlob(raw)
    }
    if (!schemas[meta.type]) {
        return null
    }
    const object = decodeObject(meta, raw)
    return object ? lcmEncode(meta.type, toLcmValue(meta.type, object)) : null
}

const ALIASES: Record<string, string[]> = {
    nsec: ["nanosec", "nsecs"],
    sec: ["secs"],
}

function pick(source: Any, name: string): Any {
    if (source === null || source === undefined || typeof source !== "object") {
        return undefined
    }
    if (name in source) {
        return source[name]
    }
    const lower = name.toLowerCase()
    if (lower in source) {
        return source[lower]
    }
    for (const alias of ALIASES[name] ?? []) {
        if (alias in source) {
            return source[alias]
        }
    }
    return undefined
}

/** A ROS 2 object shaped as the LCM schema of `type` (ROS 1 names, `X_length` fields, nsec for nanosec). */
export function toLcmValue(type: string, source: Any): Any {
    const fields = schemas[type]
    const out: Record<string, Any> = {}
    const lengthFields = new Set(
        fields.flatMap((field) => field.dims.filter((dim) => typeof dim === "string")),
    )
    for (const field of fields) {
        if (lengthFields.has(field.name)) {
            continue // the encoder counts the array
        }
        const value = pick(source, field.name)
        if (value === undefined) {
            continue
        }
        if (field.type in schemas) {
            out[field.name] = field.dims.length
                ? Array.from(
                    value as Iterable<Any>,
                    (item) => toLcmValue(field.type, item),
                )
                : toLcmValue(field.type, value)
        } else if (field.type === "int64_t" && typeof value === "bigint") {
            out[field.name] = Number(value)
        } else {
            out[field.name] = value
        }
    }
    return out
}

// ── images ──

export type ImageFrame = {
    kind: "image" | "depth"
    frame: string
    width: number
    height: number
    /** jpeg | png | webp for an encoded frame; a ROS encoding (mono8, rgb8, bgr8, rgba8, bgra8, 16UC1, 32FC1) for raw */
    encoding: string
    data: Uint8Array
}

const ENCODED = new Set(["jpeg", "jpg", "png", "webp"])
const DEPTH = new Set(["16uc1", "mono16", "32fc1"])

function formatOf(format: string): string {
    const lower = format.toLowerCase()
    return lower.includes("png") ? "png" : lower.includes("webp") ? "webp" : "jpeg"
}

export function decodeImage(
    meta: StreamMeta,
    raw: Uint8Array,
): ImageFrame | null {
    const message = decodeObject(meta, raw)
    if (!message?.data) {
        return null
    }
    const frame = message.header?.frame_id ?? ""
    const data = message.data instanceof Uint8Array ? message.data : new Uint8Array(message.data)
    if (message.format !== undefined && message.encoding === undefined) {
        return {
            kind: "image",
            frame,
            width: 0,
            height: 0,
            encoding: formatOf(message.format),
            data,
        }
    }
    const encoding = String(message.encoding ?? "")
    const lower = encoding.toLowerCase()
    if (ENCODED.has(lower)) {
        return {
            kind: "image",
            frame,
            width: message.width ?? 0,
            height: message.height ?? 0,
            encoding: formatOf(lower),
            data,
        }
    }
    return {
        kind: DEPTH.has(lower) ? "depth" : "image",
        frame,
        width: message.width ?? 0,
        height: message.height ?? 0,
        encoding: lower === "mono16" ? "16UC1" : DEPTH.has(lower) ? encoding.toUpperCase() : lower,
        data,
    }
}

const BYTES_PER_PIXEL: Record<string, number> = {
    mono8: 1,
    "8uc1": 1,
    rgb8: 3,
    bgr8: 3,
    rgba8: 4,
    bgra8: 4,
    "16UC1": 2,
    "32FC1": 4,
}

export function bytesPerPixel(encoding: string): number {
    return BYTES_PER_PIXEL[encoding] ?? 0
}

/** A raw image cut down (every Nth pixel) so its longest side is at most `side`; encoded frames come back as they are. */
export function shrinkImage(
    image: ImageFrame,
    side = LOW_IMAGE_SIDE,
): ImageFrame {
    const bpp = bytesPerPixel(image.encoding)
    if (!bpp || !image.width || !image.height) {
        return image
    }
    const step = Math.ceil(Math.max(image.width, image.height) / side)
    if (step <= 1) {
        return image
    }
    const width = Math.floor(image.width / step)
    const height = Math.floor(image.height / step)
    const out = new Uint8Array(width * height * bpp)
    const rowBytes = Math.floor(image.data.byteLength / image.height)
    for (let y = 0; y < height; y++) {
        const from = y * step * rowBytes
        for (let x = 0; x < width; x++) {
            const at = from + x * step * bpp
            out.set(image.data.subarray(at, at + bpp), (y * width + x) * bpp)
        }
    }
    return { ...image, width, height, data: out }
}

// ── point clouds ──

export type Cloud = {
    frame: string
    /** points in the source cloud */
    sourceCount: number
    positions: Float32Array
    intensity: Uint8Array | null
}

const DATATYPE_SIZE: Record<number, number> = {
    1: 1,
    2: 1,
    3: 2,
    4: 2,
    5: 4,
    6: 4,
    7: 4,
    8: 8,
}

function reader(
    datatype: number,
    view: DataView,
    little: boolean,
): ((at: number) => number) | null {
    switch (datatype) {
        case 1:
            return (at) => view.getInt8(at)
        case 2:
            return (at) => view.getUint8(at)
        case 3:
            return (at) => view.getInt16(at, little)
        case 4:
            return (at) => view.getUint16(at, little)
        case 5:
            return (at) => view.getInt32(at, little)
        case 6:
            return (at) => view.getUint32(at, little)
        case 7:
            return (at) => view.getFloat32(at, little)
        case 8:
            return (at) => view.getFloat64(at, little)
    }
    return null
}

/** sensor_msgs/PointCloud2 → xyz (non-finite points dropped) + intensity scaled to 0..255; `maxPoints` thins it. */
export function decodeCloud(
    meta: StreamMeta,
    raw: Uint8Array,
    maxPoints = Infinity,
): Cloud | null {
    const message = decodeObject(meta, raw)
    if (!message?.data || !message.fields) {
        return null
    }
    const data: Uint8Array = message.data instanceof Uint8Array ? message.data : new Uint8Array(message.data)
    const step = Number(message.point_step ?? 0)
    const total = step > 0 ? Math.floor(data.byteLength / step) : 0
    const fields = new Map<string, { offset: number; datatype: number }>()
    for (const field of message.fields as Any[]) {
        fields.set(String(field.name), {
            offset: Number(field.offset),
            datatype: Number(field.datatype),
        })
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const little = !message.is_bigendian
    const x = fields.get("x"), y = fields.get("y"), z = fields.get("z")
    const readX = x && reader(x.datatype, view, little)
    const readY = y && reader(y.datatype, view, little)
    const readZ = z && reader(z.datatype, view, little)
    if (!x || !y || !z || !readX || !readY || !readZ) {
        return null
    }
    const intensityField = fields.get("intensity") ?? fields.get("i")
    const readI = intensityField && DATATYPE_SIZE[intensityField.datatype]
        ? reader(intensityField.datatype, view, little)
        : null
    const keepEvery = Math.max(1, Math.ceil(total / maxPoints))
    const kept = Math.ceil(total / keepEvery)
    const positions = new Float32Array(kept * 3)
    const values = readI ? new Float32Array(kept) : null
    let n = 0
    let low = Infinity, high = -Infinity
    for (let point = 0; point < total; point += keepEvery) {
        const at = point * step
        const px = readX(at + x.offset),
            py = readY(at + y.offset),
            pz = readZ(at + z.offset)
        if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) {
            continue
        }
        positions[n * 3] = px
        positions[n * 3 + 1] = py
        positions[n * 3 + 2] = pz
        if (values && readI) {
            const value = readI(at + intensityField!.offset)
            values[n] = value
            low = Math.min(low, value)
            high = Math.max(high, value)
        }
        n++
    }
    let intensity: Uint8Array | null = null
    if (values) {
        intensity = new Uint8Array(n)
        const scale = high > low ? 255 / (high - low) : 0
        for (let i = 0; i < n; i++) {
            intensity[i] = Math.round((values[i] - low) * scale)
        }
    }
    return {
        frame: message.header?.frame_id ?? "",
        sourceCount: total,
        positions: positions.subarray(0, n * 3),
        intensity,
    }
}

// ── the wire: one binary websocket message per delivered message ──

/** [u32 header length][header JSON, padded to 4][payload] */
export function packet(
    header: Record<string, unknown>,
    ...parts: Uint8Array[]
): Uint8Array {
    const json = new TextEncoder().encode(JSON.stringify(header))
    const headerLength = Math.ceil(json.byteLength / 4) * 4
    const total = 4 + headerLength +
        parts.reduce((sum, part) => sum + part.byteLength, 0)
    const out = new Uint8Array(total)
    new DataView(out.buffer).setUint32(0, headerLength, true)
    out.fill(0x20, 4, 4 + headerLength)
    out.set(json, 4)
    let at = 4 + headerLength
    for (const part of parts) {
        out.set(part, at)
        at += part.byteLength
    }
    return out
}

export function cloudPacket(
    header: Record<string, unknown>,
    cloud: Cloud,
): Uint8Array {
    const positions = new Uint8Array(
        cloud.positions.buffer,
        cloud.positions.byteOffset,
        cloud.positions.byteLength,
    )
    return packet(
        {
            ...header,
            k: "cloud",
            frame: cloud.frame,
            n: cloud.positions.length / 3,
            source: cloud.sourceCount,
            i: !!cloud.intensity,
        },
        positions,
        ...(cloud.intensity ? [cloud.intensity] : []),
    )
}

export function imagePacket(
    header: Record<string, unknown>,
    image: ImageFrame,
): Uint8Array {
    return packet(
        {
            ...header,
            k: image.kind,
            frame: image.frame,
            w: image.width,
            h: image.height,
            enc: image.encoding,
        },
        image.data,
    )
}

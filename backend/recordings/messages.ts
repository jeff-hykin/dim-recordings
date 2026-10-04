// The few message payloads this app reads: images (for thumbnails) and TF frame names (for the frame tree), in LCM
// (dimos .db blobs, raw-LCM .mcap channels) and ROS 2 CDR (.mcap).
import { lz4, MessageReader, parseMessageDefinition } from "../deps.ts"

export type DecodedImage = {
    width: number
    height: number
    /** a ROS encoding (rgb8, bgr8, mono8, 16UC1, ...) or, for compressed frames, the format (jpeg, png) */
    encoding: string
    compressed: boolean
    data: Uint8Array
}

const LZ4_MAGIC = 0x184d2204

/** A .db blob: LCM bytes, lz4-framed when the stream's codec is `lz4+lcm`. */
export function unwrapBlob(blob: Uint8Array): Uint8Array {
    if (blob.byteLength >= 4 && new DataView(blob.buffer, blob.byteOffset).getUint32(0, true) === LZ4_MAGIC) {
        return new Uint8Array(lz4.decompress(blob))
    }
    return blob
}

class LcmCursor {
    view: DataView
    at = 8 // after the 8-byte fingerprint
    constructor(public bytes: Uint8Array) {
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    }
    int32() {
        const value = this.view.getInt32(this.at, false)
        this.at += 4
        return value
    }
    int8() {
        return this.view.getInt8(this.at++)
    }
    string() {
        const length = this.int32()
        let end = this.at + length
        const stop = end
        while (end > this.at && this.bytes[end - 1] === 0) {
            end--
        }
        const text = new TextDecoder().decode(this.bytes.subarray(this.at, end))
        this.at = stop
        return text
    }
    bytesOf(length: number) {
        const out = this.bytes.subarray(this.at, this.at + length)
        this.at += length
        return out
    }
    header() {
        this.int32() // seq
        this.int32() // stamp.sec
        this.int32() // stamp.nsec
        return this.string() // frame_id
    }
}

const COMPRESSED = new Set(["jpeg", "jpg", "png", "webp"])

/** LCM sensor_msgs/Image (what dimos stores, also for its `jpeg` codec, whose encoding field says jpeg). */
export function decodeLcmImage(bytes: Uint8Array): DecodedImage {
    const cursor = new LcmCursor(bytes)
    // LCM puts an array's length field where the struct declares it: dimos_lcm declares data_length first
    const length = cursor.int32()
    cursor.header()
    const height = cursor.int32()
    const width = cursor.int32()
    const encoding = cursor.string()
    cursor.int8() // is_bigendian
    cursor.int32() // step
    return { width, height, encoding, compressed: COMPRESSED.has(encoding.toLowerCase()), data: cursor.bytesOf(length) }
}

/** LCM sensor_msgs/CompressedImage. Its size is only known once decoded, so width/height are 0. */
export function decodeLcmCompressedImage(bytes: Uint8Array): DecodedImage {
    const cursor = new LcmCursor(bytes)
    const length = cursor.int32() // data_length, declared first
    cursor.header()
    const format = cursor.string()
    return { width: 0, height: 0, encoding: compressedFormat(format), compressed: true, data: cursor.bytesOf(length) }
}

/** "rgb8; jpeg compressed bgr8" → jpeg */
function compressedFormat(format: string): string {
    const lower = format.toLowerCase()
    return lower.includes("png") ? "png" : lower.includes("webp") ? "webp" : "jpeg"
}

/** A ROS 2 message reader from an mcap schema (ros2msg text), cached per schema. */
const readers = new Map<string, MessageReader>()
export function cdrReader(schemaName: string, schemaText: string): MessageReader {
    const key = `${schemaName}\n${schemaText}`
    let reader = readers.get(key)
    if (!reader) {
        reader = new MessageReader(parseMessageDefinition(schemaText, { ros2: true }))
        readers.set(key, reader)
    }
    return reader
}

/** A CDR sensor_msgs/msg/Image or CompressedImage. */
export function decodeCdrImage(schemaName: string, schemaText: string, bytes: Uint8Array): DecodedImage {
    const message = cdrReader(schemaName, schemaText).readMessage(bytes) as {
        width?: number
        height?: number
        encoding?: string
        format?: string
        data: Uint8Array
    }
    if (message.format !== undefined) {
        return { width: 0, height: 0, encoding: compressedFormat(message.format), compressed: true, data: message.data }
    }
    return {
        width: message.width ?? 0,
        height: message.height ?? 0,
        encoding: message.encoding ?? "",
        compressed: false,
        data: message.data,
    }
}

export type Edge = { parent: string; child: string }

/** LCM tf2_msgs/TFMessage: frame names only (dtk tools/db_summary.js). */
export function decodeLcmFrames(data: Uint8Array): Edge[] {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const count = data.length >= 12 ? view.getInt32(8, false) : 0
    let offset = 12
    const readString = () => {
        const length = view.getInt32(offset, false)
        offset += 4
        let end = offset + length
        const stop = end
        while (end > offset && data[end - 1] === 0) {
            end--
        }
        const text = new TextDecoder().decode(data.subarray(offset, end))
        offset = stop
        return text
    }
    const edges: Edge[] = []
    for (let index = 0; index < count; index++) {
        offset += 12 // seq + stamp
        if (offset > data.length) {
            break
        }
        const parent = readString()
        const child = readString()
        offset += 7 * 8
        if (offset > data.length) {
            break
        }
        edges.push({ parent, child })
    }
    return edges
}

/** CDR tf2_msgs/msg/TFMessage: frame names only. */
export function decodeCdrFrames(data: Uint8Array): Edge[] {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const little = (view.getUint8(1) & 1) === 1
    let at = 4
    const align = (width: number) => {
        at += (width - ((at - 4) % width)) % width
    }
    const uint32 = () => {
        align(4)
        const value = view.getUint32(at, little)
        at += 4
        return value
    }
    const string = () => {
        const length = uint32()
        const text = new TextDecoder().decode(data.subarray(at, at + Math.max(0, length - 1)))
        at += length
        return text
    }
    const edges: Edge[] = []
    for (let i = uint32(); i > 0 && at < data.length; i--) {
        uint32()
        uint32()
        const parent = string()
        const child = string()
        align(8)
        at += 7 * 8
        edges.push({ parent, child })
    }
    return edges
}

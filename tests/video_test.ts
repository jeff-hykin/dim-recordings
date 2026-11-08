// Camera streams recorded as video. The point of these tests is the thing that made the Replayer show nothing for
// them: a video frame is not a picture on its own, so decoding the single message the playhead lands on fails, and
// only feeding everything from the last keyframe forward produces one.
//
// The access units here come from a real encode (ffmpeg, once, into a temp file), so the decoder under test meets a
// real stream rather than bytes shaped like one.
import { assert, assertEquals } from "@std/assert"
import { lcmCompressedVideo, tempDir, writeDb } from "./fixtures.ts"
import { openSource } from "../backend/replay/source.ts"
import { isKeyframe, isVideoType, lastJpeg, splitJpegs, VideoFrames } from "../backend/replay/video.ts"

const ffmpeg = await (async () => {
    try {
        return (await new Deno.Command("ffmpeg", { args: ["-version"], stdout: "null", stderr: "null" }).output())
            .success
    } catch {
        return false
    }
})()

/** a real H.264 stream, split into one access unit per frame (keyframe every `gop` frames) */
async function encodedUnits(frames: number, gop: number): Promise<Uint8Array[]> {
    const dir = await tempDir()
    const path = `${dir}/clip.h264`
    const made = await new Deno.Command("ffmpeg", {
        args: [
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            `testsrc=size=160x120:rate=10:duration=${frames / 10}`,
            "-c:v",
            "libx264",
            "-g",
            String(gop),
            "-pix_fmt",
            "yuv420p",
            "-f",
            "h264",
            path,
            "-y",
        ],
        stdout: "null",
        stderr: "piped",
    }).output()
    assert(made.success, new TextDecoder().decode(made.stderr))
    const bytes = Deno.readFileSync(path)
    Deno.removeSync(dir, { recursive: true })

    // cut at each picture start: a VCL unit (H.264 types 1 and 5), carrying any parameter sets that precede it
    const marks: { at: number; vcl: boolean }[] = []
    for (let i = 0; i + 3 < bytes.length; i++) {
        if (bytes[i] !== 0 || bytes[i + 1] !== 0) {
            continue
        }
        const at = bytes[i + 2] === 1 ? i + 3 : (bytes[i + 2] === 0 && bytes[i + 3] === 1 ? i + 4 : -1)
        if (at < 0) {
            continue
        }
        const type = bytes[at] & 0x1f
        if (type === 1 || type === 5 || type === 7 || type === 8) {
            marks.push({ at: at - (bytes[at - 3] === 1 ? 3 : 4), vcl: type === 1 || type === 5 })
        }
    }
    const units: Uint8Array[] = []
    for (let i = 0; i < marks.length; i++) {
        if (!marks[i].vcl) {
            continue
        }
        // a parameter set immediately before this picture belongs with it
        let from = marks[i].at
        for (let back = i - 1; back >= 0 && !marks[back].vcl; back--) {
            from = marks[back].at
        }
        const nextVcl = marks.slice(i + 1).find((m) => m.vcl)
        let to = bytes.length
        if (nextVcl) {
            to = nextVcl.at
            for (let back = marks.indexOf(nextVcl) - 1; back >= 0 && !marks[back].vcl; back--) {
                to = marks[back].at
            }
        }
        units.push(bytes.slice(from, to))
    }
    return units
}

/** a recording whose one stream is those access units, one message each */
async function videoRecording(units: Uint8Array[]) {
    const dir = await tempDir()
    const path = `${dir}/video.db`
    writeDb(path, [{
        name: "/front_camera",
        payload: "foxglove_msgs.CompressedVideo",
        times: units.map((_, i) => 1700000000 + i * 0.1),
        blob: (i) => lcmCompressedVideo(units[i]),
    }])
    return { dir, path }
}

Deno.test("a video stream is recognised as a camera, not left as 'other'", () => {
    assert(isVideoType("foxglove_msgs.CompressedVideo"))
    assert(isVideoType("CompressedVideo"))
    assert(!isVideoType("sensor_msgs.CompressedImage"))
})

Deno.test({
    name: "only the keyframes of a real encode read as keyframes",
    ignore: !ffmpeg,
    fn: async () => {
        const units = await encodedUnits(20, 10)
        const keys = units.map((unit, i) => (isKeyframe(unit, false) ? i : -1)).filter((i) => i >= 0)
        assertEquals(keys[0], 0, "the stream must open on a keyframe")
        assert(keys.length >= 2, `expected more than one keyframe, got ${keys.length}`)
        assert(keys.length < units.length, "not every frame can be a keyframe, or the test proves nothing")
    },
})

Deno.test({
    name: "the frame the playhead lands on decodes, even when it is not a keyframe",
    ignore: !ffmpeg,
    fn: async () => {
        const units = await encodedUnits(20, 10)
        const { dir, path } = await videoRecording(units)
        const source = await openSource(path)
        try {
            const meta = source.streams.find((s) => s.name === "/front_camera")!
            assertEquals(meta.kind, "image", "a video stream must reach the image machinery")

            const frames = new VideoFrames(source, meta)
            // 7 is mid-group: it depends on the keyframe at 0, so it is the case that used to render nothing
            const middle = await frames.frameAt(7)
            assert(middle, "frame 7 did not decode")
            assertEquals(middle.encoding, "jpeg")
            assert(middle.data.length > 0, "frame 7 decoded to no bytes")
            assertEquals([...middle.data.slice(0, 3)], [0xff, 0xd8, 0xff], "not a jpeg")

            // and a keyframe itself still works
            const key = await frames.frameAt(0)
            assert(key && key.data.length > 0, "the keyframe did not decode")
        } finally {
            source.close()
            Deno.removeSync(dir, { recursive: true })
        }
    },
})

Deno.test({
    name: "seeking backwards over a keyframe boundary still decodes",
    ignore: !ffmpeg,
    fn: async () => {
        const units = await encodedUnits(20, 10)
        const { dir, path } = await videoRecording(units)
        const source = await openSource(path)
        try {
            const meta = source.streams.find((s) => s.name === "/front_camera")!
            const frames = new VideoFrames(source, meta)
            const late = await frames.frameAt(15) // second group
            const early = await frames.frameAt(3) // back into the first
            assert(late && late.data.length > 0, "frame 15 did not decode")
            assert(early && early.data.length > 0, "frame 3 did not decode after seeking back")
        } finally {
            source.close()
            Deno.removeSync(dir, { recursive: true })
        }
    },
})

Deno.test("the pictures are split out of one mjpeg run, start marker to end marker", () => {
    const one = new Uint8Array([0xff, 0xd8, 1, 2, 0xff, 0xd9])
    const two = new Uint8Array([0xff, 0xd8, 9, 9, 9, 0xff, 0xd9])
    const both = new Uint8Array([...one, ...two])
    assertEquals(splitJpegs(both).map((p) => [...p]), [[...one], [...two]])
    assertEquals([...lastJpeg(both)!], [...two])
    assertEquals(lastJpeg(new Uint8Array([1, 2, 3])), null)
    // a picture whose end marker never arrived is cut off, so it is left out rather than shown half-drawn
    assertEquals(splitJpegs(new Uint8Array([...one, 0xff, 0xd8, 7, 7])).length, 1)
})

Deno.test({
    name: "playing forward through a group decodes it once, not once per frame",
    ignore: !ffmpeg,
    fn: async () => {
        const units = await encodedUnits(20, 10)
        const { dir, path } = await videoRecording(units)
        const source = await openSource(path)
        try {
            const meta = source.streams.find((s) => s.name === "/front_camera")!
            // count the reads the source is asked for: redecoding from the keyframe every frame would read the
            // whole group again each time (1+2+3+... for the group), which is what this guards against
            let reads = 0
            const counting = {
                ...source,
                read: (stream: string, i: number) => {
                    reads++
                    return source.read(stream, i)
                },
            } as typeof source
            const frames = new VideoFrames(counting, meta)
            for (let i = 0; i < 10; i++) {
                const frame = await frames.frameAt(i)
                assert(frame && frame.data.length > 0, `frame ${i} did not decode`)
            }
            // the keyframe scan looks back from frame 0 (1 read), then each frame is read once as it is reached
            assert(reads <= 20, `read the recording ${reads} times for 10 frames; the group is being redecoded`)
        } finally {
            source.close()
            Deno.removeSync(dir, { recursive: true })
        }
    },
})

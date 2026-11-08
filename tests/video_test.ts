// Camera streams recorded as video. The point of these tests is the thing that made the Replayer show nothing for
// them: a video frame is not a picture on its own, so decoding the single message the playhead lands on fails, and
// only feeding everything from the last keyframe forward produces one.
//
// The access units here come from a real encode (ffmpeg, once, into a temp file), so the decoder under test meets a
// real stream rather than bytes shaped like one.
import { assert, assertEquals } from "@std/assert"
import { lcmCompressedVideo, tempDir, writeDb } from "./fixtures.ts"
import { isCameraType, kindOf, openSource } from "../backend/replay/source.ts"
import { THUMB_BUILD } from "../backend/recordings/thumbnails.ts"
import { isKeyframe, isVideoType, splitJpegs, VideoFrames } from "../backend/replay/video.ts"

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

Deno.test("every camera test agrees that a recorded video stream is a camera", () => {
    // This is the bug this test exists for: the check was copied into the previews, the Foxglove rule
    // and the page, and a video-only recording came out with "no preview" because one copy had not
    // learnt about video. One definition now, and these are the callers that must not drift again.
    for (const type of ["foxglove_msgs.CompressedVideo", "sensor_msgs.Image", "sensor_msgs.CompressedImage"]) {
        assert(isCameraType(type), `${type} should be a camera`)
        assertEquals(kindOf(type), "image", `${type} should reach the image machinery`)
    }
    for (const type of ["sensor_msgs.PointCloud2", "nav_msgs.Odometry", "sensor_msgs.CameraInfo"]) {
        assert(!isCameraType(type), `${type} is not a camera`)
    }
})

Deno.test("a 'no preview' cached before video was understood is tried again", async () => {
    // The worker skips anything that is not "pending", so the verdict written for this recording
    // before the app knew about video would have kept it previewless for ever.
    const { Thumbnailer } = await import("../backend/recordings/thumb_worker.ts")
    const dir = await tempDir()
    try {
        const worker = Object.create(Thumbnailer.prototype) as {
            folder: (f: unknown) => Promise<string>
            stateOf: (f: unknown) => Promise<{ state: string; reason?: string }>
        }
        const folder = `${dir}/preview`
        Deno.mkdirSync(folder, { recursive: true })
        worker.folder = () => Promise.resolve(folder)
        const file = { format: "mcap" }

        for (const reason of ["no camera, and it didn't move", "no readable camera frames", "no camera stream"]) {
            Deno.writeTextFileSync(`${folder}.none.json`, JSON.stringify({ reason }))
            assertEquals((await worker.stateOf(file)).state, "pending", `${reason} should be retried`)
        }
        // a verdict this build reached is left alone, so it is not rebuilt for ever
        Deno.writeTextFileSync(
            `${folder}.none.json`,
            JSON.stringify({ build: THUMB_BUILD, reason: "the file is corrupt" }),
        )
        assertEquals((await worker.stateOf(file)).state, "none")
        // an odometry path drawn by an older build is reconsidered too: that is what the robot's recording came
        // back as when its video stream read as unopenable
        Deno.removeSync(`${folder}.none.json`)
        Deno.writeTextFileSync(
            `${folder}.path.json`,
            JSON.stringify({ stream: "slam_odom", points: [], width: 1, height: 1, length: 1 }),
        )
        assertEquals((await worker.stateOf(file)).state, "pending", "a path from an older build should be retried")
        Deno.writeTextFileSync(
            `${folder}.path.json`,
            JSON.stringify({ build: THUMB_BUILD, stream: "slam_odom", points: [], width: 1, height: 1, length: 1 }),
        )
        assertEquals((await worker.stateOf(file)).state, "path")
    } finally {
        Deno.removeSync(dir, { recursive: true })
    }
})

Deno.test({
    name: "preview frames across a clip are different pictures, not one keyframe repeated",
    ignore: !ffmpeg,
    fn: async () => {
        // The first version took the nearest keyframe. A camera sends one a second, so every frame a
        // preview asked for across a short clip landed on the same one and the preview flickered
        // between a handful of stills instead of showing the clip.
        const units = await encodedUnits(30, 10) // 3 keyframes in 30 frames, like a 3 s clip
        const { dir, path } = await videoRecording(units)
        const source = await openSource(path)
        try {
            const meta = source.streams.find((s) => s.name === "/front_camera")!
            const frames = new VideoFrames(source, meta)
            const pictures: string[] = []
            for (const i of [0, 4, 8, 12, 16, 20, 24, 28]) {
                const frame = await frames.frameAt(i)
                assert(frame, `frame ${i} did not decode`)
                // the whole picture: jpegs of the same size share their first bytes, so a prefix compares equal
                pictures.push(`${frame.data.length}:${[...frame.data].reduce((h, b) => (h * 31 + b) % 1e9, 7)}`)
            }
            const distinct = new Set(pictures).size
            assert(
                distinct >= pictures.length - 1,
                `${distinct} distinct pictures out of ${pictures.length}: the preview is repeating frames`,
            )
        } finally {
            source.close()
            Deno.removeSync(dir, { recursive: true })
        }
    },
})

Deno.test("a sprite built by an older version is made again", async () => {
    // The folder key is the recording's format, size and mtime, so a code change does not move it:
    // without this, the preview built when frames were chosen badly would be served for ever.
    const { Thumbnailer } = await import("../backend/recordings/thumb_worker.ts")
    const dir = await tempDir()
    try {
        const worker = Object.create(Thumbnailer.prototype) as {
            folder: (f: unknown) => Promise<string>
            stateOf: (f: unknown) => Promise<{ state: string }>
        }
        const folder = `${dir}/preview`
        Deno.mkdirSync(folder, { recursive: true })
        worker.folder = () => Promise.resolve(folder)
        const file = { format: "mcap" }
        const meta = { frames: 15, width: 320, height: 180, stream: "/front_camera" }

        Deno.writeTextFileSync(`${folder}/meta.json`, JSON.stringify(meta)) // no build: predates this
        assertEquals((await worker.stateOf(file)).state, "pending")

        Deno.writeTextFileSync(`${folder}/meta.json`, JSON.stringify({ ...meta, build: THUMB_BUILD - 1 }))
        assertEquals((await worker.stateOf(file)).state, "pending")

        Deno.writeTextFileSync(`${folder}/meta.json`, JSON.stringify({ ...meta, build: THUMB_BUILD }))
        assertEquals((await worker.stateOf(file)).state, "ready")
    } finally {
        Deno.removeSync(dir, { recursive: true })
    }
})

Deno.test({
    name: "a stream that starts mid-group still shows its first frames",
    ignore: !ffmpeg,
    fn: async () => {
        // Found on the robot: a recording is cut wherever the user pressed record, so its first messages are
        // plain inter frames with no keyframe anywhere before them. Those frames cannot be decoded at all, and
        // returning nothing for them took the whole camera out of the preview -- a 285 s recording of two
        // cameras came back as "no camera, and it didn't move", retried on every pass for ever.
        const units = (await encodedUnits(30, 10)).slice(4) // drops the opening keyframe: 0-5 now have none
        assert(!isKeyframe(units[0], false), "the clip must not start on a keyframe, or the test proves nothing")
        const { dir, path } = await videoRecording(units)
        const source = await openSource(path)
        try {
            const meta = source.streams.find((s) => s.name === "/front_camera")!
            const frames = new VideoFrames(source, meta)
            const first = await frames.frameAt(0)
            assert(first && first.data.length > 0, "the first frame of the recording showed nothing")
            assertEquals([...first.data.slice(0, 3)], [0xff, 0xd8, 0xff], "not a jpeg")
            // and the frames of the group that does have a keyframe are unaffected
            const later = await frames.frameAt(9)
            assert(later && later.data.length > 0, "frame 9 did not decode")
        } finally {
            source.close()
            Deno.removeSync(dir, { recursive: true })
        }
    },
})

Deno.test({
    name: "a camera whose first frame is unreadable is still found",
    ignore: !ffmpeg,
    fn: async () => {
        // Same recording, one level up: the preview probes a stream before using it, and probing only the
        // first instant meant one unreadable frame disqualified the camera.
        const { pickMainCamera } = await import("../backend/recordings/thumbnails.ts")
        const units = (await encodedUnits(30, 10)).slice(4)
        const { dir, path } = await videoRecording(units)
        try {
            const { dbSource } = await import("../backend/recordings/thumbnails.ts")
            const inspection = {
                streams: [{
                    name: "/front_camera",
                    type: "foxglove_msgs.CompressedVideo",
                    count: units.length,
                    start: 1700000000,
                    end: 1700000000 + (units.length - 1) * 0.1,
                }],
            }
            // deno-lint-ignore no-explicit-any
            const source = await dbSource(path, inspection as any)
            try {
                assert(pickMainCamera(await source.candidates()), "the camera was not found")
            } finally {
                source.close()
            }
        } finally {
            Deno.removeSync(dir, { recursive: true })
        }
    },
})

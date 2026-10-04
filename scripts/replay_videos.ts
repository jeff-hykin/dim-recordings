/// <reference lib="dom" />
// Screen captures of the Replayer working, against a running Desktop (headless Chrome video → mp4):
//   deno run -A scripts/replay_videos.ts <desktop url> <out dir> [names...]
// playing, scrubbing (thumbnails → full frames), the per-stream timeline, stream edits (on copies made here in the
// recordings folder, never on a linked file), and the backend's memory while a 5 GB recording is scrubbed end to end.
import { type Browser, chromium, type Page } from "playwright-core"

const [desktop = "http://127.0.0.1:7341", out = "videos", ...only] = Deno.args
const app = `${desktop}/apps/dim-recordings/`
const recordingsDir = Deno.env.get("RECORDINGS_DIR") ?? "/tmp/dd_gb1/recordings"
const executablePath = Deno.env.get("CHROME") ??
    `${
        Deno.env.get("HOME")
    }/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell`
await Deno.mkdir(out, { recursive: true })

const POINTER = `
addEventListener("DOMContentLoaded", () => {
    if (window.top !== window) return
    const dot = document.createElement("div")
    dot.style.cssText = "position:fixed;z-index:99999;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;" +
        "background:rgba(255,80,160,.55);border:2px solid #fff;pointer-events:none;left:-20px;top:-20px;transition:transform .1s"
    document.documentElement.appendChild(dot)
    addEventListener("mousemove", (e) => { dot.style.left = e.clientX + "px"; dot.style.top = e.clientY + "px" }, true)
    addEventListener("mousedown", () => dot.style.transform = "scale(.6)", true)
    addEventListener("mouseup", () => dot.style.transform = "", true)
})`

/** A caption across the top of the video, so the recording says what it shows. */
async function caption(page: Page, text: string) {
    await page.evaluate((text) => {
        let box = document.getElementById("video-caption")
        if (!box) {
            box = document.createElement("div")
            box.id = "video-caption"
            box.style.cssText =
                "position:fixed;z-index:99998;left:50%;top:56px;transform:translateX(-50%);padding:6px 14px;" +
                "font:500 13px Inter,system-ui;color:#ece8f0;background:rgba(5,7,13,.86);border:1px solid #7cc8ec;pointer-events:none"
            document.documentElement.appendChild(box)
        }
        box.textContent = text
        box.style.display = text ? "" : "none"
    }, text)
}

async function record(browser: Browser, name: string, url: string, scenario: (page: Page) => Promise<void>) {
    const dir = await Deno.makeTempDir()
    const context = await browser.newContext({
        viewport: { width: 1440, height: 860 },
        colorScheme: "dark",
        recordVideo: { dir, size: { width: 1440, height: 860 } },
    })
    await context.addInitScript(POINTER)
    const page = await context.newPage()
    page.on("pageerror", (error) => console.error(`[${name}] page error:`, error.message))
    await page.goto(url)
    await page.waitForTimeout(3500)
    try {
        await scenario(page)
    } catch (error) {
        console.error(`[${name}]`, error)
    }
    await page.waitForTimeout(800)
    const video = page.video()!
    await context.close()
    const mp4 = `${out}/${name}.mp4`
    await new Deno.Command("ffmpeg", {
        args: [
            "-y",
            "-loglevel",
            "error",
            "-i",
            await video.path(),
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-crf",
            "24",
            "-movflags",
            "+faststart",
            mp4,
        ],
    }).output()
    await Deno.remove(dir, { recursive: true })
    console.log(mp4)
}

async function hover(page: Page, selector: string, steps = 14) {
    const box = await page.locator(selector).first().boundingBox()
    if (!box) {
        throw new Error(`nothing to hover: ${selector}`)
    }
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps })
    await page.waitForTimeout(250)
}

/** Drags along the scrubber from one fraction of it to another, pausing `holdMs` at the end with the button down. */
async function scrub(page: Page, from: number, to: number, ms: number, release = true, holdMs = 0) {
    const box = (await page.locator('[data-testid="scrubber"]').boundingBox())!
    const y = box.y + box.height / 2
    await page.mouse.move(box.x + box.width * from, y, { steps: 10 })
    await page.mouse.down()
    const steps = Math.max(2, Math.round(ms / 40))
    for (let i = 1; i <= steps; i++) {
        await page.mouse.move(box.x + box.width * (from + ((to - from) * i) / steps), y)
        await page.waitForTimeout(40)
    }
    if (holdMs) {
        await page.waitForTimeout(holdMs)
    }
    if (release) {
        await page.mouse.up()
    }
}

const replay = (id: string) => `${app}#/replay/${encodeURIComponent(id)}`

async function run(command: string, args: string[]) {
    const { stdout, stderr } = await new Deno.Command(command, { args, stdout: "piped", stderr: "piped" }).output()
    return new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr)
}

/** terminal color codes (ESC [ … m) */
const ANSI_COLOR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g")

/** Shows a terminal's output as a page (the end card of a video). */
async function terminal(page: Page, title: string, text: string) {
    await page.setContent(
        `<body style="margin:0;background:#05070d;color:#ece8f0;font:12.5px/1.45 'IBM Plex Mono',Menlo,monospace">` +
            `<div style="padding:22px 28px"><div style="font:600 12px Inter,system-ui;letter-spacing:.12em;color:#7cc8ec;margin-bottom:12px">${title}</div>` +
            `<pre style="margin:0;white-space:pre-wrap">${
                text.replace(ANSI_COLOR, "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
            }</pre></div></body>`,
    )
}

const scenarios: Record<string, () => Promise<[string, (page: Page) => Promise<void>]>> = {
    replayer_playing: () =>
        Promise.resolve([replay("go2_short.db"), async (page) => {
            await caption(
                page,
                "Replayer: the Controller's view of a recording: point clouds, the odometry route, camera, tf",
            )
            await page.waitForTimeout(1500)
            await hover(page, '[data-testid="play"]')
            await page.locator('[data-testid="play"]').click()
            await page.waitForTimeout(5000)
            await caption(page, "2× speed")
            await page.locator(".tl-speed").selectOption("2")
            await page.waitForTimeout(4000)
            await caption(page, "the tf tree, from the recording")
            await hover(page, '.topbar .tab[aria-label="TF"]')
            await page.locator('.topbar .tab[aria-label="TF"]').click()
            await page.waitForTimeout(3500)
            await page.locator('.topbar .tab[aria-label="Layers"]').click()
            await caption(page, "no drive / WASD / arm controls: a replay only plays")
            await page.waitForTimeout(3500)
            await hover(page, '[data-testid="play"]')
            await page.locator('[data-testid="play"]').click()
            await caption(page, "paused")
            await page.waitForTimeout(1500)
        }]),
    replayer_scrubbing: () =>
        Promise.resolve([replay("go2_short.db"), async (page) => {
            // the camera big (the 3D view becomes a picture-in-picture), so its resolution is plain to see
            await page.locator(".camera-panel .camera-head").first().dblclick()
            await page.waitForTimeout(1200)
            await caption(
                page,
                "scrubbing: the camera shows 192-px thumbnails (see its label), the 3D clouds are thinned",
            )
            await scrub(page, 0.1, 0.45, 3500, false, 0)
            await caption(page, "holding still mid-scrub: the full frame arrives")
            await page.waitForTimeout(1600)
            await caption(page, "scrubbing again: thumbnails")
            const box = (await page.locator('[data-testid="scrubber"]').boundingBox())!
            for (let i = 0; i <= 40; i++) {
                await page.mouse.move(box.x + box.width * (0.45 + 0.35 * (i / 40)), box.y + box.height / 2)
                await page.waitForTimeout(45)
            }
            await page.mouse.up()
            await caption(page, "released (paused): full resolution within a moment")
            await page.waitForTimeout(2500)
            await caption(page, "the 3D view: clouds thinned while scrubbing, full when it stops")
            await page.locator(".pip-expand").click()
            await page.waitForTimeout(1500)
            await scrub(page, 0.8, 0.3, 3000, false, 0)
            await page.waitForTimeout(300)
            await page.mouse.up()
            await caption(page, "released: full clouds")
            await page.waitForTimeout(2500)
            await caption(page, "playing: full frames")
            await page.locator('[data-testid="play"]').click()
            await page.waitForTimeout(3500)
        }]),
    replayer_timeline_rows: () =>
        Promise.resolve([replay("go2_short.db"), async (page) => {
            await caption(page, "the timeline expands to a row per stream, a tick per message")
            await hover(page, '[data-testid="expand"]')
            await page.locator('[data-testid="expand"]').click()
            await page.waitForTimeout(2000)
            await page.locator('[data-testid="play"]').click()
            await page.waitForTimeout(3000)
            await caption(page, "scroll over the rows to zoom the time axis")
            await hover(page, '.tl-row[data-stream="color_image_embedded"] .tl-lane')
            for (let i = 0; i < 8; i++) {
                await page.mouse.wheel(0, -180)
                await page.waitForTimeout(200)
            }
            await page.waitForTimeout(2000)
            await caption(page, "click a row to seek")
            const lane = (await page.locator('.tl-row[data-stream="lidar"] .tl-lane').boundingBox())!
            await page.mouse.move(lane.x + lane.width * 0.7, lane.y + lane.height / 2, { steps: 12 })
            await page.mouse.down()
            await page.mouse.up()
            await page.waitForTimeout(2500)
            await page.locator('.timeline button:has-text("Fit")').click()
            await page.waitForTimeout(1500)
            await caption(page, "a row's eye draws or hides that stream")
            await hover(page, '.tl-row[data-stream="lidar"] .tl-eye')
            await page.locator('.tl-row[data-stream="lidar"] .tl-eye').click()
            await page.waitForTimeout(2000)
            await page.locator('.tl-row[data-stream="lidar"] .tl-eye').click()
            await page.waitForTimeout(2000)
        }]),
    replayer_stream_edits: async () => {
        // a fresh copy (77 MB) in the recordings folder: the edits change this copy only
        const id = "replay_edit_demo.mcap"
        await Deno.copyFile(`${recordingsDir}/go2_short_clip_today.mcap`, `${recordingsDir}/${id}`)
        return [replay(id), async (page) => {
            const menu = async (stream: string, item: string) => {
                await hover(page, `.tl-row[data-stream="${stream}"] .tl-menu`)
                await page.locator(`.tl-row[data-stream="${stream}"] .tl-menu`).click()
                await page.waitForTimeout(500)
                await hover(page, `.menu-item:has-text("${item}")`)
                await page.locator(`.menu-item:has-text("${item}")`).click()
                await page.waitForTimeout(600)
            }
            await caption(page, `${id}: a copy of a go2 clip`)
            await page.locator('[data-testid="expand"]').click()
            await page.waitForTimeout(1800)
            await caption(page, "rename odom → odom_raw (in place: the file is rewritten beside itself and swapped in)")
            await menu("odom", "Rename")
            await page.locator(".dialog input").fill("")
            await page.locator(".dialog input").pressSequentially("odom_raw", { delay: 60 })
            await page.waitForTimeout(500)
            await page.locator('.dialog button:has-text("Rename")').click()
            await page.waitForTimeout(3500)
            await caption(page, "duplicate lidar → lidar_copy")
            await page.locator('[data-testid="expand"][aria-expanded="false"]').click({ timeout: 1000 }).catch(() => {})
            await menu("lidar", "Duplicate")
            await page.locator('.dialog button:has-text("Duplicate")').click()
            await page.waitForTimeout(4000)
            await caption(page, "delete color_image_embedded")
            await menu("color_image_embedded", "Delete")
            await page.waitForTimeout(800)
            await page.locator('.dialog button:has-text("Delete stream")').click()
            await page.waitForTimeout(4000)
            await caption(page, "the edited recording plays")
            await page.locator('[data-testid="play"]').click()
            await page.waitForTimeout(3500)
            await caption(page, "")
            const files = (await run("ls", ["-la", recordingsDir])).split("\n").filter((line) =>
                line.includes("replay_edit_demo") || line.includes("editing")
            ).join("\n")
            const summary = await run("dtk", ["data", "summary", `${recordingsDir}/${id}`])
            await terminal(
                page,
                `ls ${recordingsDir} | grep replay_edit_demo   (no copy left beside it)\n\ndtk data summary ${id}`,
                `${files}\n\n${summary}`,
            )
            await page.waitForTimeout(6000)
        }]
    },
    replayer_stream_edits_db: async () => {
        // a fresh copy (147 MB) of a .db in the recordings folder: the edits change this copy only
        const id = "replay_edit_demo.db"
        for (const suffix of ["", "-wal", "-shm"]) {
            await Deno.remove(`${recordingsDir}/${id}${suffix}`).catch(() => {})
        }
        await new Promise((resolve) => setTimeout(resolve, 1500)) // the app notices the folder change
        await Deno.copyFile(`${recordingsDir}/alfred_stereo_short.db`, `${recordingsDir}/${id}`)
        return [replay(id), async (page) => {
            const menu = async (stream: string, item: string) => {
                await hover(page, `.tl-row[data-stream="${stream}"] .tl-menu`)
                await page.locator(`.tl-row[data-stream="${stream}"] .tl-menu`).click()
                await page.waitForTimeout(500)
                await hover(page, `.menu-item:has-text("${item}")`)
                await page.locator(`.menu-item:has-text("${item}")`).click()
                await page.waitForTimeout(600)
            }
            await caption(page, `${id}: a copy of a memory2 .db (a stereo camera)`)
            await page.locator('[data-testid="expand"][aria-expanded="false"]').click({ timeout: 1500 }).catch(() => {})
            await page.waitForTimeout(1800)
            const streams = await page.locator(".tl-row").evaluateAll((rows) =>
                rows.map((row) => row.getAttribute("data-stream"))
            )
            const first = streams.find((name) => name === "infrared_left") ?? streams[0]!
            const other = streams.find((name) => name && name !== first && /info|right/.test(name)) ?? streams[1]!
            await caption(page, `rename ${first} → camera_left (ALTER TABLE, in place)`)
            await menu(first, "Rename")
            await page.locator(".dialog input").fill("")
            await page.locator(".dialog input").pressSequentially("camera_left", { delay: 60 })
            await page.locator('.dialog button:has-text("Rename")').click()
            await page.waitForTimeout(3000)
            await caption(page, "duplicate tf → tf_copy")
            await menu("tf", "Duplicate")
            await page.locator(".dialog input").fill("tf_copy")
            await page.locator('.dialog button:has-text("Duplicate")').click()
            await page.waitForTimeout(3000)
            await caption(page, `delete ${other}`)
            await menu(other, "Delete")
            await page.locator('.dialog button:has-text("Delete stream")').click()
            await page.waitForTimeout(3000)
            await caption(page, "the edited recording plays")
            await page.locator('[data-testid="play"]').click()
            await page.waitForTimeout(3000)
            await caption(page, "")
            const files = (await run("ls", ["-la", recordingsDir])).split("\n").filter((line) =>
                line.includes("replay_edit_demo.db")
            ).join("\n")
            const summary = await run("dtk", ["data", "summary", `${recordingsDir}/${id}`])
            await terminal(
                page,
                `ls ${recordingsDir} | grep replay_edit_demo.db\n\ndtk data summary ${id}`,
                `${files}\n\n${summary}`,
            )
            await page.waitForTimeout(6000)
        }]
    },
    replayer_rss: async () => {
        const pid = (await run("pgrep", ["-f", "dim-recordings-backend.*server.js"])).trim().split("\n")[0]
        if (!pid) {
            throw new Error("no dim-recordings backend running")
        }
        const id = "spot_small_loop.db"
        const size = (await Deno.stat(`${recordingsDir}/${id}`)).size
        return [replay(id), async (page) => {
            let peak = 0
            let stop = false
            const sampler = (async () => {
                while (!stop) {
                    const rss = Number((await run("ps", ["-o", "rss=", "-p", pid])).trim()) / 1024
                    peak = Math.max(peak, rss)
                    await page.evaluate(([rss, peak, gb]) => {
                        let box = document.getElementById("rss-hud")
                        if (!box) {
                            box = document.createElement("div")
                            box.id = "rss-hud"
                            box.style.cssText = "position:fixed;z-index:99998;right:16px;top:58px;padding:10px 14px;" +
                                "font:12px 'IBM Plex Mono',Menlo,monospace;color:#ece8f0;background:rgba(5,7,13,.9);border:1px solid #7cc8ec;pointer-events:none;white-space:pre"
                            document.documentElement.appendChild(box)
                        }
                        box.textContent = `recording   ${gb.toFixed(2)} GB on disk\nbackend RSS ${
                            rss.toFixed(0)
                        } MB now\npeak        ${peak.toFixed(0)} MB`
                    }, [rss, peak, size / 1e9]).catch(() => {})
                    await new Promise((resolve) => setTimeout(resolve, 400))
                }
            })()
            await caption(page, `${id} (${(size / 1e9).toFixed(1)} GB, 10 cameras): opened without loading it`)
            await page.waitForTimeout(2500)
            await caption(page, "scrubbing start → end")
            await scrub(page, 0.02, 0.98, 7000, true)
            await page.waitForTimeout(1500)
            await scrub(page, 0.98, 0.3, 4000, true)
            await caption(page, "playing at 4×")
            await page.locator(".tl-speed").selectOption("4")
            await page.locator('[data-testid="play"]').click()
            await page.waitForTimeout(8000)
            await page.locator('[data-testid="play"]').click()
            await caption(page, `peak backend RSS ${peak.toFixed(0)} MB for a ${(size / 1e9).toFixed(1)} GB file`)
            await page.waitForTimeout(3500)
            stop = true
            await sampler
            console.log(JSON.stringify({ recording: id, fileGB: size / 1e9, peakRssMB: Math.round(peak) }))
        }]
    },
}

// the GPU (Metal) even headless, so the 3D view records at its real frame rate
const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"],
})
for (const [name, make] of Object.entries(scenarios)) {
    if (only.length && !only.includes(name)) {
        continue
    }
    const [url, scenario] = await make()
    await record(browser, name, url, scenario)
}
await browser.close()

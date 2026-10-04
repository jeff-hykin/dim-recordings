// Screen captures of the app working (headless Chrome video → mp4):
//   deno run -A scripts/videos.ts <desktop url> <out dir> [names...]
// Each scenario drives the real app on a running Desktop; a drawn pointer shows where the mouse is.
import { type Browser, chromium, type Frame, type Page } from "playwright-core"

const [desktop = "http://127.0.0.1:7341", out = "videos", ...only] = Deno.args
const app = `${desktop}/apps/dim-recordings/`
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
    const move = (x, y) => { dot.style.left = x + "px"; dot.style.top = y + "px" }
    addEventListener("mousemove", (e) => move(e.clientX, e.clientY), true)
    addEventListener("mousedown", () => dot.style.transform = "scale(.6)", true)
    addEventListener("mouseup", () => dot.style.transform = "", true)
    window.__pointer = move
})`

type Scenario = (page: Page, frame: () => Page | Frame) => Promise<void>

async function record(
    browser: Browser,
    name: string,
    url: string,
    scenario: Scenario,
    scheme: "dark" | "light" = "dark",
) {
    const dir = await Deno.makeTempDir()
    const context = await browser.newContext({
        viewport: { width: 1440, height: 860 },
        colorScheme: scheme,
        recordVideo: { dir, size: { width: 1440, height: 860 } },
    })
    await context.addInitScript(POINTER)
    const page = await context.newPage()
    page.on("pageerror", (error) => console.error(`[${name}] page error:`, error.message))
    await page.goto(url)
    await page.waitForTimeout(2500)
    const inShell = url.includes("?app=")
    const frame = () => inShell ? page.frames().find((f) => f.url().includes("/apps/dim-recordings/")) ?? page : page
    try {
        await scenario(page, frame)
    } catch (error) {
        console.error(`[${name}]`, error)
    }
    await page.waitForTimeout(800)
    const video = page.video()!
    await context.close()
    const webm = await video.path()
    const mp4 = `${out}/${name}.mp4`
    const ffmpeg = new Deno.Command("ffmpeg", {
        args: [
            "-y",
            "-loglevel",
            "error",
            "-i",
            webm,
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-crf",
            "26",
            "-movflags",
            "+faststart",
            mp4,
        ],
    })
    await ffmpeg.output()
    await Deno.remove(dir, { recursive: true })
    console.log(mp4)
}

/** Moves the (drawn) pointer smoothly onto an element and hovers it. */
async function hover(page: Page, target: ReturnType<Page["locator"]>, steps = 12) {
    const box = await target.boundingBox()
    if (!box) {
        throw new Error("no box to hover")
    }
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps })
    await page.waitForTimeout(300)
}

const row = (page: Page, id: string) => page.locator(`.row[data-id="${id}"]`)

const scenarios: Record<string, [string, Scenario, ("dark" | "light")?]> = {
    list_sort: [app, async (page) => {
        await page.waitForTimeout(1200)
        await page.mouse.wheel(0, 500)
        await page.waitForTimeout(1200)
        await page.mouse.wheel(0, 900)
        await page.waitForTimeout(1200)
        await page.mouse.wheel(0, -1400)
        await page.waitForTimeout(600)
        for (const label of ["Size", "Size", "Duration", "Duration", "Date", "Date"]) {
            await hover(page, page.locator(".sorts button", { hasText: label }))
            await page.locator(".sorts button", { hasText: label }).click()
            await page.waitForTimeout(1600)
        }
        await page.mouse.wheel(0, 900)
        await page.waitForTimeout(1200)
    }],
    list_research_theme: [app, async (page) => {
        await page.waitForTimeout(1500)
        await page.mouse.wheel(0, 700)
        await page.waitForTimeout(1500)
    }, "light"],
    summary_notes: [app, async (page) => {
        for (const id of ["go2_short_clip_today.mcap", "alfred_stereo_short_lcm.mcap", "spot_small_loop.db"]) {
            await row(page, id).scrollIntoViewIfNeeded()
            await hover(page, row(page, id).locator("button", { hasText: "Summary" }))
            await page.waitForTimeout(1800)
            await hover(page, page.locator(".summary .streams"))
            await page.waitForTimeout(800)
        }
        await row(page, "spot_small_loop.db").locator("button", { hasText: "Summary" }).click()
        await page.waitForTimeout(600)
        const notes = page.locator(".summary textarea")
        await hover(page, notes)
        await notes.click()
        await notes.fill("")
        await notes.pressSequentially("Spot loop around the office, 10 cameras. Good for testing depth.", { delay: 35 })
        await page.waitForTimeout(1500)
        await page.reload()
        await page.waitForTimeout(2500)
        await row(page, "spot_small_loop.db").scrollIntoViewIfNeeded()
        await hover(page, row(page, "spot_small_loop.db").locator("button", { hasText: "Summary" }))
        await page.waitForTimeout(2500)
    }],
    open_menu: [app, async (page) => {
        for (const id of ["go2_short.db", "go2_short.mcap", "alfred_stereo_short_lcm.mcap"]) {
            await row(page, id).scrollIntoViewIfNeeded()
            await hover(page, row(page, id).locator(".menu-wrap button", { hasText: "Open" }))
            await page.waitForTimeout(700)
            for (const item of await row(page, id).locator(".menu-item").all()) {
                await hover(page, item, 6)
                await page.waitForTimeout(500)
            }
            await page.waitForTimeout(900)
            await page.mouse.move(300, 30, { steps: 8 })
            await page.waitForTimeout(400)
        }
        await row(page, "go2_short.mcap").scrollIntoViewIfNeeded()
        await hover(page, row(page, "go2_short.mcap").locator(".menu-wrap button", { hasText: "Open" }))
        await hover(page, row(page, "go2_short.mcap").locator(".menu-item", { hasText: "Replayer" }))
        await row(page, "go2_short.mcap").locator(".menu-item", { hasText: "Replayer" }).click()
        await page.waitForTimeout(2000)
        await hover(page, page.locator("button", { hasText: "Recordings" }))
        await page.locator("button", { hasText: "Recordings" }).click()
        await page.waitForTimeout(1500)
    }],
    open_map_editor: [`${desktop}/?app=dim-recordings`, async (page, frame) => {
        await page.waitForTimeout(2500)
        const f = frame()
        const target = f.locator(`.row[data-id="mid360_athens_stairs.db"]`)
        await target.scrollIntoViewIfNeeded()
        await target.locator(".menu-wrap button", { hasText: "Open" }).hover()
        await page.waitForTimeout(800)
        await target.locator(".menu-item", { hasText: "Map Editor" }).hover()
        await page.waitForTimeout(600)
        await target.locator(".menu-item", { hasText: "Map Editor" }).click()
        await page.waitForTimeout(7000)
    }],
    thumbnails: [app, async (page) => {
        await page.waitForTimeout(4000)
        for (const id of ["go2_short_clip_today.mcap", "spot_small_loop.db"]) {
            const thumb = row(page, id).locator(".thumb")
            await thumb.scrollIntoViewIfNeeded()
            const box = (await thumb.boundingBox())!
            await page.mouse.move(box.x + 2, box.y + box.height / 2, { steps: 10 })
            for (let i = 0; i <= 40; i++) {
                await page.mouse.move(box.x + 2 + (box.width - 4) * (i / 40), box.y + box.height / 2)
                await page.waitForTimeout(90)
            }
            for (let i = 40; i >= 0; i--) {
                await page.mouse.move(box.x + 2 + (box.width - 4) * (i / 40), box.y + box.height / 2)
                await page.waitForTimeout(60)
            }
            await page.mouse.move(700, 30, { steps: 8 })
            await page.waitForTimeout(2500)
        }
    }],
    actions: [app, async (page) => {
        const id = "go2_short_clip_today.mcap"
        const more = (rowId: string) => row(page, rowId).locator(".menu-wrap button", { hasText: "⋯" })
        // duplicate
        await hover(page, more(id))
        await hover(page, row(page, id).locator(".menu-item", { hasText: "Duplicate" }))
        await row(page, id).locator(".menu-item", { hasText: "Duplicate" }).click()
        await page.waitForTimeout(2500)
        const copy = "go2_short_clip_today copy.mcap"
        // rename the copy
        await row(page, copy).scrollIntoViewIfNeeded()
        await hover(page, more(copy))
        await hover(page, row(page, copy).locator(".menu-item", { hasText: "Rename" }))
        await row(page, copy).locator(".menu-item", { hasText: "Rename" }).click()
        await page.waitForTimeout(500)
        await page.locator(".dialog input").fill("")
        await page.locator(".dialog input").pressSequentially("go2_demo_renamed", { delay: 50 })
        await hover(page, page.locator(".dialog button", { hasText: "Rename" }))
        await page.locator(".dialog button", { hasText: "Rename" }).click()
        await page.waitForTimeout(2500)
        // convert it to .db, with progress
        const renamed = "go2_demo_renamed.mcap"
        await row(page, renamed).scrollIntoViewIfNeeded()
        await hover(page, more(renamed))
        await hover(page, row(page, renamed).locator(".menu-item", { hasText: ".db" }))
        await row(page, renamed).locator(".menu-item", { hasText: ".db" }).click()
        for (let i = 0; i < 40; i++) {
            await page.waitForTimeout(500)
            if (!(await row(page, renamed).locator(".job").count())) {
                break
            }
        }
        await page.waitForTimeout(2500)
        // delete the renamed copy and its .db, with the confirm
        for (const target of ["go2_demo_renamed.db", renamed]) {
            await row(page, target).scrollIntoViewIfNeeded()
            await hover(page, more(target))
            await hover(page, row(page, target).locator(".menu-item", { hasText: "Delete" }))
            await row(page, target).locator(".menu-item", { hasText: "Delete" }).click()
            await page.waitForTimeout(1200)
            await hover(page, page.locator(".dialog button", { hasText: "Delete" }))
            await page.locator(".dialog button", { hasText: "Delete" }).click()
            await page.waitForTimeout(2000)
        }
    }],
    upload: [app, async (page) => {
        const id = "go2_short_clip_upload.mcap"
        await row(page, id).scrollIntoViewIfNeeded()
        await hover(page, row(page, id).locator("button", { hasText: "Upload" }))
        await row(page, id).locator("button", { hasText: "Upload" }).click()
        for (let i = 0; i < 120; i++) {
            await page.waitForTimeout(500)
            if (await row(page, id).locator("a", { hasText: "View" }).count()) {
                break
            }
        }
        await page.waitForTimeout(1500)
        await hover(page, row(page, id).locator("a", { hasText: "View" }))
        await page.waitForTimeout(2000)
    }],
    open_rrd: [`${desktop}/?app=dim-recordings`, async (page, frame) => {
        await page.waitForTimeout(2500)
        const f = frame()
        const rrd = f.locator(`.rrd[data-id="mid360_athens_stairs.rrd"]`)
        await rrd.scrollIntoViewIfNeeded()
        await page.waitForTimeout(1200)
        await rrd.locator("button", { hasText: "Open" }).hover()
        await page.waitForTimeout(800)
        await rrd.locator("button", { hasText: "Open" }).click()
        await page.waitForTimeout(9000)
    }],
}

const browser = await chromium.launch({ executablePath })
for (const [name, [url, scenario, scheme]] of Object.entries(scenarios)) {
    if (only.length && !only.includes(name)) {
        continue
    }
    await record(browser, name, url, scenario, scheme)
}
await browser.close()

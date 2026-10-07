// The three.js view: one renderer, a ROS-convention (Z up) scene in the fixed frame, orbit/follow camera, a 2D
// label overlay, and a render loop that only draws when something changed. It also keeps the latency numbers.
import * as THREE from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import { CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js"
import { Store } from "../store.ts"
import { focusDistance, splatBackground } from "./pointMaterial.ts"
import { themeColors } from "../../../dim-app/theme.js"
import { FRAME_BUDGET_MS, splatFallback } from "./rendering.ts"
import { SmoothFollow } from "./follow.ts"

export interface RenderStats {
    fps: number
    /** CPU time of one frame: layer updates + render submit (ms, mean) */
    frameMs: number
    /** gateway timestamp → the frame that drew it (ms, p50 / p95 over the last second) */
    latencyP50: number | null
    latencyP95: number | null
    /** message arrival in the page → the frame that drew it (ms, p50) */
    arrivalToFrameMs: number | null
    drawCalls: number
    points: number
}

export interface FrameInfo {
    /** performance.now() of this frame */
    now: number
    fixedFrame: string
    camera: THREE.PerspectiveCamera
}

export type FrameListener = (frame: FrameInfo) => void

/** The canvas renders at the screen's resolution, up to 2× (beyond that the extra pixels cost more than they show). */
const pixelRatio = () => Math.min(2, devicePixelRatio || 1)

export class Viewer {
    readonly renderer: THREE.WebGLRenderer
    readonly labels: CSS2DRenderer
    readonly scene = new THREE.Scene()
    readonly camera = new THREE.PerspectiveCamera(60, 1, 0.05, 10000)
    readonly controls: OrbitControls
    readonly stats = new Store<RenderStats>({
        fps: 0,
        frameMs: 0,
        latencyP50: null,
        latencyP95: null,
        arrivalToFrameMs: null,
        drawCalls: 0,
        points: 0,
    })
    /** world units → pixels at 1 m depth; point shaders size by it */
    readonly pixelsPerMeter = { value: 1 }
    /** view size in CSS pixels; thick-line materials share it (their widths are CSS pixels) */
    readonly resolution = new THREE.Vector2(1, 1)
    fixedFrame = "world"
    /** where the camera follows (a TF frame); set by the app each frame */
    followTarget: THREE.Vector3 | null = null

    #host: HTMLElement
    #dirty = true
    #listeners = new Set<FrameListener>()
    #grid: THREE.GridHelper
    #frameTimes: number[] = []
    #cpuTimes: number[] = []
    #pendingData: { bridgeTs: number; arrival: number }[] = []
    #latencies: number[] = []
    #arrivals: number[] = []
    #lastStats = 0
    #lastDeclutter = 0
    #slowSeconds = 0
    #bridgeNow: () => number
    #follow = new SmoothFollow()
    #lastFollow = new THREE.Vector3()
    #following = false
    #followDelta = new THREE.Vector3()
    #lastFrame = 0

    constructor(host: HTMLElement, bridgeNow: () => number) {
        this.#host = host
        this.#bridgeNow = bridgeNow
        // no MSAA (as MemWorld): it nearly doubled the cost of blended splats at 2880×1800
        this.renderer = new THREE.WebGLRenderer({
            antialias: false,
            alpha: true,
            powerPreference: "high-performance",
        })
        this.renderer.setPixelRatio(pixelRatio())
        this.renderer.setClearColor(0x000000, 0)
        host.appendChild(this.renderer.domElement)
        this.labels = new CSS2DRenderer()
        this.labels.domElement.className = "label-layer"
        host.appendChild(this.labels.domElement)

        this.camera.up.set(0, 0, 1)
        this.camera.position.set(-6, -6, 5)
        this.controls = new OrbitControls(this.camera, this.renderer.domElement)
        this.controls.enableDamping = true
        this.controls.dampingFactor = 0.18
        this.controls.screenSpacePanning = false
        this.controls.maxPolarAngle = Math.PI * 0.495
        this.controls.addEventListener("change", () => this.requestRender())

        this.scene.add(new THREE.HemisphereLight(0xdde8ff, 0x202830, 1.6))
        const sun = new THREE.DirectionalLight(0xffffff, 1.2)
        sun.position.set(5, 3, 10)
        this.scene.add(sun)
        this.#grid = this.#makeGrid(true)
        this.scene.add(this.#grid)

        this.#observer = new ResizeObserver(() => this.#resize())
        this.#observer.observe(host)
        this.#watchPixelRatio()
        this.#resize()
        requestAnimationFrame(this.#loop)
    }

    #makeGrid(dark: boolean): THREE.GridHelper {
        // the theme's --scene-grid-major / --scene-grid (Portal: violet-black lines on the void; Research: warm hairlines on paper)
        const colors = themeColors()
        const grid = new THREE.GridHelper(
            200,
            200,
            new THREE.Color(colors.sceneGridMajor || (dark ? "#2a2734" : "#c8c6bb")),
            new THREE.Color(colors.sceneGrid || (dark ? "#1a1822" : "#dcdad0")),
        )
        grid.rotation.x = Math.PI / 2
        const material = grid.material as THREE.Material
        material.transparent = true
        material.opacity = dark ? 0.7 : 0.55
        return grid
    }

    /** Grid, fog and light for a dark or light page (the background itself is CSS behind the transparent canvas). */
    setTheme(dark: boolean) {
        this.scene.remove(this.#grid)
        this.#grid.geometry.dispose()
        ;(this.#grid.material as THREE.Material).dispose()
        this.#grid = this.#makeGrid(dark)
        this.scene.add(this.#grid)
        // light: the far grid fades into the page; dark: no fog, like MemWorld (scene.js)
        const background = themeColors().sceneBg || (dark ? "#05070d" : "#f5f4ef")
        this.scene.fog = dark ? null : new THREE.Fog(new THREE.Color(background), 40, 110)
        splatBackground.setStyle(background, THREE.NoColorSpace)
        this.requestRender()
    }

    /** Hides scene labels that overlap a more important one (frame names give way to data labels, then to the nearer). */
    #declutter() {
        const elements = [
            ...this.labels.domElement.querySelectorAll<HTMLElement>(".scene-label"),
        ].filter((element) => element.style.display !== "none")
        const placed: DOMRect[] = []
        const ranked = elements
            .map((element) => ({
                element,
                rect: element.getBoundingClientRect(),
                minor: element.classList.contains("frame-label"),
            }))
            .sort((a, b) => Number(a.minor) - Number(b.minor))
        for (const { element, rect } of ranked) {
            const hit = placed.some((other) =>
                rect.left < other.right && rect.right > other.left &&
                rect.top < other.bottom && rect.bottom > other.top
            )
            element.classList.toggle("covered", hit)
            if (!hit) {
                placed.push(rect)
            }
        }
    }

    requestRender() {
        this.#dirty = true
    }

    /** Layers call this when a message changed what's drawn; the next frame both draws it and times it. */
    noteData(bridgeTimestampMs: number) {
        this.#pendingData.push({
            bridgeTs: bridgeTimestampMs,
            arrival: performance.now(),
        })
        this.#dirty = true
    }

    onFrame(listener: FrameListener): () => void {
        this.#listeners.add(listener)
        return () => this.#listeners.delete(listener)
    }

    /**
     * The point in the scene (the fixed frame) under a screen point (client px): the nearest drawn cloud point within a
     * few pixels of the ray or the nearest mesh hit (a map plane, a marker), else where the ray meets the ground (z = 0).
     * Null when the ray misses everything and points away from the ground.
     */
    pick(
        clientX: number,
        clientY: number,
    ): { point: THREE.Vector3; on: "points" | "mesh" | "ground" } | null {
        const rect = this.renderer.domElement.getBoundingClientRect()
        const ndc = new THREE.Vector2(
            ((clientX - rect.left) / rect.width) * 2 - 1,
            -((clientY - rect.top) / rect.height) * 2 + 1,
        )
        const raycaster = new THREE.Raycaster()
        raycaster.setFromCamera(ndc, this.camera)
        const { origin, direction } = raycaster.ray
        // a cloud point counts within PICK_PX pixels of the ray: that's a cone of this slope
        const PICK_PX = 6
        const slope = (PICK_PX * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * 2) /
            Math.max(1, rect.height)
        type Hit = {
            distance: number
            point: THREE.Vector3
            on: "points" | "mesh"
        }
        // `as`: assigned inside visit(), which TS's narrowing can't see
        let best = null as Hit | null
        const meshes: THREE.Object3D[] = []
        const point = new THREE.Vector3()
        const offset = new THREE.Vector3()
        const visit = (object: THREE.Object3D) => {
            if (!object.visible || object.userData.noPick) {
                return
            }
            if ((object as THREE.Points).isPoints) {
                const geometry = (object as THREE.Points).geometry
                const position = geometry.getAttribute("position") as
                    | THREE.BufferAttribute
                    | undefined
                if (position) {
                    const end = Math.min(
                        position.count,
                        geometry.drawRange.start + geometry.drawRange.count,
                    )
                    const array = position.array as ArrayLike<number>
                    const world = object.matrixWorld
                    for (let index = geometry.drawRange.start; index < end; index++) {
                        point.set(
                            array[index * 3],
                            array[index * 3 + 1],
                            array[index * 3 + 2],
                        ).applyMatrix4(world)
                        offset.subVectors(point, origin)
                        const along = offset.dot(direction)
                        if (along <= this.camera.near || (best && along >= best.distance)) {
                            continue
                        }
                        const away = offset.addScaledVector(direction, -along).length()
                        if (away <= along * slope) {
                            best = { distance: along, point: point.clone(), on: "points" }
                        }
                    }
                }
            } else if ((object as THREE.Mesh).isMesh) {
                meshes.push(object)
            }
            for (const child of object.children) {
                visit(child)
            }
        }
        this.scene.updateMatrixWorld()
        visit(this.scene)
        const hit = raycaster.intersectObjects(meshes, false)[0]
        if (hit && (!best || hit.distance < best.distance)) {
            best = { distance: hit.distance, point: hit.point.clone(), on: "mesh" }
        }
        if (best) {
            return { point: best.point, on: best.on }
        }
        const ground = raycaster.ray.intersectPlane(
            new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
            new THREE.Vector3(),
        )
        return ground ? { point: ground, on: "ground" } : null
    }

    /** Looks at `target` from the current direction, `distance` away. */
    frame(target: THREE.Vector3, distance: number) {
        const direction = this.camera.position.clone().sub(this.controls.target)
            .normalize()
        if (!Number.isFinite(direction.x) || direction.lengthSq() === 0) {
            direction.set(-1, -1, 0.9).normalize()
        }
        this.controls.target.copy(target)
        this.camera.position.copy(target).addScaledVector(direction, distance)
        this.#following = false
        this.#follow.reset()
        this.requestRender()
    }

    topDown(target: THREE.Vector3, distance: number) {
        this.controls.target.copy(target)
        this.camera.position.set(
            target.x,
            target.y - distance * 0.01,
            target.z + distance,
        )
        this.#following = false
        this.#follow.reset()
        this.requestRender()
    }

    /**
     * devicePixelRatio changes when the window moves between a Retina and a 1× display or the page is zoomed; a ratio
     * read once at startup leaves the canvas at the old resolution (blurry, pixelated) until a reload.
     */
    #watchPixelRatio() {
        const query = matchMedia(`(resolution: ${devicePixelRatio}dppx)`)
        query.addEventListener("change", () => {
            this.renderer.setPixelRatio(pixelRatio())
            this.#resize()
            this.#watchPixelRatio()
        }, { once: true })
    }

    #resize() {
        const width = Math.max(1, this.#host.clientWidth)
        const height = Math.max(1, this.#host.clientHeight)
        this.renderer.setSize(width, height)
        this.labels.setSize(width, height)
        this.camera.aspect = width / height
        this.camera.updateProjectionMatrix()
        this.resolution.set(width, height)
        this.pixelsPerMeter.value = (height * this.renderer.getPixelRatio()) /
            (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2))
        this.requestRender()
    }

    #disposed = false
    #observer: ResizeObserver | null = null

    /** Stops drawing and frees the GL context (the Replayer remounts the view after a stream edit). */
    dispose() {
        this.#disposed = true
        this.#observer?.disconnect()
        this.controls.dispose()
        this.renderer.dispose()
        this.renderer.forceContextLoss()
        this.renderer.domElement.remove()
        this.labels.domElement.remove()
    }

    #loop = (now: number) => {
        if (this.#disposed) {
            return
        }
        requestAnimationFrame(this.#loop)
        // following moves camera and target together, so the user's angle and zoom stay put; the followed point glides
        // between poses (follow.ts) rather than jumping with each one
        const dt = this.#lastFrame ? (now - this.#lastFrame) / 1000 : 0
        this.#lastFrame = now
        if (this.followTarget) {
            const [x, y, z] = this.#follow.step([
                this.followTarget.x,
                this.followTarget.y,
                this.followTarget.z,
            ], dt)
            if (this.#following) {
                const delta = this.#followDelta.set(x, y, z).sub(this.#lastFollow)
                if (delta.lengthSq() > 1e-10) {
                    this.camera.position.add(delta)
                    this.controls.target.add(delta)
                    this.#dirty = true
                }
            }
            this.#lastFollow.set(x, y, z)
            this.#following = true
        } else {
            this.#following = false
            this.#follow.reset()
        }
        focusDistance.value = this.camera.position.distanceTo(this.controls.target)
        if (this.controls.update()) {
            this.#dirty = true
        }
        const started = performance.now()
        const info: FrameInfo = {
            now,
            fixedFrame: this.fixedFrame,
            camera: this.camera,
        }
        for (const listener of this.#listeners) {
            listener(info)
        }
        if (this.#dirty) {
            this.#dirty = false
            this.renderer.render(this.scene, this.camera)
            this.labels.render(this.scene, this.camera)
            if (now - this.#lastDeclutter > 150) {
                this.#lastDeclutter = now
                this.#declutter()
            }
            const drawn = performance.now()
            // everything that arrived before this frame is on screen once the GPU picks this frame up
            if (this.#pendingData.length) {
                const bridgeNow = this.#bridgeNow()
                for (const data of this.#pendingData) {
                    this.#latencies.push(bridgeNow - data.bridgeTs)
                    this.#arrivals.push(drawn - data.arrival)
                }
                this.#pendingData.length = 0
            }
            this.#cpuTimes.push(drawn - started)
        }
        this.#frameTimes.push(now)
        if (now - this.#lastStats > 1000) {
            this.#publishStats(now)
        }
    }

    #publishStats(now: number) {
        const percentile = (values: number[], p: number) => {
            if (!values.length) {
                return null
            }
            const sorted = [...values].sort((a, b) => a - b)
            return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
        }
        const span = (now - this.#lastStats) / 1000
        const info = this.renderer.info
        let points = 0
        let splats = false
        this.scene.traverseVisible((object) => {
            if ((object as THREE.Points).isPoints) {
                splats ||= "SPLAT" in
                    (((object as THREE.Points).material as THREE.ShaderMaterial)
                        .defines ?? {})
                const geometry = (object as THREE.Points).geometry
                points += Math.min(
                    geometry.drawRange.count,
                    geometry.getAttribute("position")?.count ?? 0,
                )
            }
        })
        this.stats.set({
            fps: Math.round(this.#frameTimes.length / span),
            frameMs: this.#cpuTimes.length ? this.#cpuTimes.reduce((a, b) => a + b, 0) / this.#cpuTimes.length : 0,
            latencyP50: percentile(this.#latencies, 0.5),
            latencyP95: percentile(this.#latencies, 0.95),
            arrivalToFrameMs: percentile(this.#arrivals, 0.5),
            drawCalls: info.render.calls,
            points,
        })
        // splats that can't keep up for 3 s in a row are drawn as cubes instead (the stats pill says so; clicking it retries)
        const frameMs = this.#frameTimes.length > 1
            ? (this.#frameTimes[this.#frameTimes.length - 1] - this.#frameTimes[0]) /
                (this.#frameTimes.length - 1)
            : 0
        this.#slowSeconds = splats && frameMs > FRAME_BUDGET_MS * 1.25 ? this.#slowSeconds + 1 : 0
        if (this.#slowSeconds >= 3 && !splatFallback.get().active) {
            splatFallback.set({ active: true, frameMs })
        }
        this.#frameTimes.length = 0
        this.#cpuTimes.length = 0
        this.#latencies.length = 0
        this.#arrivals.length = 0
        this.#lastStats = now
    }
}

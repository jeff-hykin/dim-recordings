// Ported unchanged from dim-controller (frontend/src/core/grass.ts): keep the two in step.
// Grass on a simulated world's height fields (those whose material is "grass*"): one InstancedMesh of 7-vertex blades,
// a dark-root-to-light-tip gradient, clumped height and hue, normals pointing up like the terrain's, and a wind sway done
// in the vertex shader (nothing per blade on the CPU after it's built). Visual only: never picked, casts no shadow.
// The same technique as World Builder's editor (src/editor/nature.ts there), after threejsresources.com/guides/grass,
// smythdesign.com/blog/stylized-grass-webgl and Ghost of Tsushima's grass talk.
import * as THREE from "three"

/** blades per square meter at density 1, and the cap on one field's blades at density 1 */
export const BLADES_PER_M2 = 160
export const MAX_BLADES = 40000
/** the density slider's top: a field's mesh is allocated for this many, and `count` shows a prefix of them */
export const MAX_DENSITY = 2

/** seconds, shared by every grass material; the layer advances it each frame while grass is on screen */
export const windTime = { value: 0 }

export interface HeightField {
    nrow: number
    ncol: number
    /** MuJoCo's [x half-size, y half-size, top, bottom thickness] */
    size: number[]
    /** nrow x ncol, 0..1 of `top`; row 0 at -y, column 0 at -x */
    heights: ArrayLike<number>
}

/** The field's surface height at (x, y) in its own frame (bilinear between samples; clamped at the edges). */
export function heightAt(field: HeightField, x: number, y: number): number {
    const [rx, ry, top] = field.size
    const u = THREE.MathUtils.clamp(((x + rx) / (2 * rx)) * (field.ncol - 1), 0, field.ncol - 1)
    const v = THREE.MathUtils.clamp(((y + ry) / (2 * ry)) * (field.nrow - 1), 0, field.nrow - 1)
    // the cell's lower-left sample (a 1-sample field has a single cell)
    const col = Math.max(0, Math.min(Math.floor(u), field.ncol - 2))
    const row = Math.max(0, Math.min(Math.floor(v), field.nrow - 2))
    const fu = u - col
    const fv = v - row
    const c1 = Math.min(col + 1, field.ncol - 1)
    const r1 = Math.min(row + 1, field.nrow - 1)
    const at = (r: number, c: number) => field.heights[r * field.ncol + c]
    const bottom = at(row, col) * (1 - fu) + at(row, c1) * fu
    const upper = at(r1, col) * (1 - fu) + at(r1, c1) * fu
    return (bottom * (1 - fv) + upper * fv) * top
}

/** How many blades a field of `area` m² gets at `density` (1 = the default look). */
export function bladeCount(area: number, density: number): number {
    return Math.max(0, Math.min(Math.round(MAX_BLADES * density), Math.round(area * BLADES_PER_M2 * density)))
}

function hash(x: number, y: number): number {
    const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
    return v - Math.floor(v)
}

export interface Blade {
    x: number
    y: number
    /** where its root sits: on the surface, a centimeter down so it never floats */
    z: number
    height: number
    width: number
    yaw: number
    /** 0..1, the slow field that groups blades into patches of height and hue */
    clump: number
}

/**
 * The first `count` blades on `field` (in its frame). Each blade depends only on its index, so any prefix is an even
 * spread: a lower density draws fewer of the same blades.
 */
export function placeBlades(field: HeightField, count: number): Blade[] {
    const [sx, sy] = field.size
    const blades: Blade[] = []
    for (let i = 0; i < count; i++) {
        const x = (hash(i * 0.731, 17.3) * 2 - 1) * sx
        const y = (hash(i * 0.519, 91.7) * 2 - 1) * sy
        const clump = hash(Math.floor(x * 1.3), Math.floor(y * 1.3))
        // shorter toward the edges: a soft fringe rather than a carpet's cut
        const edge = Math.min(sx - Math.abs(x), sy - Math.abs(y))
        const fringe = THREE.MathUtils.smoothstep(edge, 0, 0.9)
        blades.push({
            x,
            y,
            z: heightAt(field, x, y) - 0.01,
            height: (0.14 + 0.14 * clump + 0.07 * hash(i, 3.1)) * (0.25 + 0.75 * fringe),
            width: 0.05 + 0.025 * hash(i, 7.7),
            yaw: hash(i, 5.3) * Math.PI * 2,
            clump,
        })
    }
    return blades
}

/** one blade, 1 tall along +z: three tapered segments, slightly curved, its root dark and its tip light */
function bladeGeometry(): THREE.BufferGeometry {
    const levels = [0, 0.35, 0.7, 1]
    const halfWidth = [0.5, 0.42, 0.25, 0]
    const positions: number[] = []
    const colors: number[] = []
    for (let i = 0; i < levels.length; i++) {
        const z = levels[i]
        const lean = 0.18 * z * z
        const shade = 0.58 + 0.47 * z
        const warm = 1 - 0.14 * z * z
        for (const side of i === levels.length - 1 ? [0] : [-1, 1]) {
            positions.push(side * halfWidth[i], lean, z)
            colors.push(shade, shade, shade * warm)
        }
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3))
    // every normal up: the blade shades like the ground it grows from, so a meadow reads soft, not noisy
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(positions.map((_, i) => (i % 3 === 2 ? 1 : 0)), 3))
    geometry.setIndex([0, 1, 3, 0, 3, 2, 2, 3, 5, 2, 5, 4, 4, 5, 6])
    return geometry
}

function grassMaterial(): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.85,
        metalness: 0,
        side: THREE.DoubleSide,
    })
    material.onBeforeCompile = (shader) => {
        shader.uniforms.uWindTime = windTime
        shader.vertexShader = shader.vertexShader
            .replace("#include <common>", "#include <common>\nuniform float uWindTime;")
            .replace(
                "#include <begin_vertex>",
                `#include <begin_vertex>
                {
                    // sway grows toward the tip; neighbours share a slow wave and a faster flutter (world-space, so coherent)
                    float bend = position.z * position.z;
                    vec4 root = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
                    float wave = sin(uWindTime * 1.1 + root.x * 0.32 + root.y * 0.21);
                    float flutter = sin(uWindTime * 3.1 + root.x * 1.7 - root.y * 1.3) * 0.35;
                    vec3 wind = vec3(0.09 * (wave + flutter) + 0.05, 0.05 * (wave - flutter), -0.02 * abs(wave)) * bend;
                    transformed += inverse(mat3(modelMatrix * instanceMatrix)) * wind;
                }`,
            )
    }
    return material
}

/**
 * Grass for one height field, allocated for MAX_DENSITY: set `mesh.count = bladeCount(area, density)` to thin it.
 * `color` is the field's green. A child of the field's mesh, so it shares its pose.
 */
export function grassFor(field: HeightField, color: THREE.Color): { mesh: THREE.InstancedMesh; area: number } {
    const area = 4 * field.size[0] * field.size[1]
    const capacity = bladeCount(area, MAX_DENSITY)
    const mesh = new THREE.InstancedMesh(bladeGeometry(), grassMaterial(), Math.max(capacity, 1))
    const hsl = color.getHSL({ h: 0, s: 0, l: 0 }, THREE.SRGBColorSpace)
    const matrix = new THREE.Matrix4()
    const rotation = new THREE.Quaternion()
    const axis = new THREE.Vector3(0, 0, 1)
    const tint = new THREE.Color()
    placeBlades(field, capacity).forEach((blade, i) => {
        rotation.setFromAxisAngle(axis, blade.yaw)
        matrix.compose(
            new THREE.Vector3(blade.x, blade.y, blade.z),
            rotation,
            new THREE.Vector3(blade.width, blade.width, blade.height),
        )
        mesh.setMatrixAt(i, matrix)
        tint.setHSL(
            hsl.h + (blade.clump - 0.5) * 0.035 + (hash(i, 1.9) - 0.5) * 0.012,
            Math.min(1, hsl.s * (1.08 + (blade.clump - 0.5) * 0.15)),
            Math.min(0.85, hsl.l * (1.12 + (blade.clump - 0.5) * 0.12 + (hash(i, 2.7) - 0.5) * 0.08)),
            THREE.SRGBColorSpace,
        )
        mesh.setColorAt(i, tint)
    })
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) {
        mesh.instanceColor.needsUpdate = true
    }
    mesh.count = bladeCount(area, 1)
    mesh.castShadow = false
    mesh.receiveShadow = true
    mesh.frustumCulled = false // the blades span the whole field; the blade's own bounds don't
    mesh.raycast = () => {}
    mesh.userData.grass = true
    return { mesh, area }
}

/** A software (CPU) WebGL renderer: SwiftShader, llvmpipe and friends, where thousands of blades would crawl. */
export function isSoftwareRenderer(renderer: string): boolean {
    return /swiftshader|llvmpipe|softpipe|software|basic render|mesa offscreen|lavapipe/i.test(renderer)
}

/** The GPU's name as WebGL reports it ("" when there's no WebGL or the browser hides it). */
export function probeRendererName(): string {
    try {
        const gl = document.createElement("canvas").getContext("webgl2") ??
            document.createElement("canvas").getContext("webgl")
        if (!gl) {
            return ""
        }
        const info = gl.getExtension("WEBGL_debug_renderer_info")
        const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? "")
        gl.getExtension("WEBGL_lose_context")?.loseContext()
        return name
    } catch {
        return ""
    }
}

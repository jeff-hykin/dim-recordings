// Depth images as a heat map, coloured on the GPU: the raw depth goes up as a one-channel texture and the shader
// looks each pixel up in a colour ramp (near = hot, far = cold); zero / NaN (no return) is transparent. Used by the
// camera panels (a WebGL2 canvas each) and the 3D projection (a three.js material).
import * as THREE from "three"
import { sampleGradient } from "./gradients.ts"
import type { DepthImage } from "../video.ts"

export interface DepthLook {
    colormap: string
    /** meters; null = automatic (2nd–98th percentile of valid depth, eased) */
    near: number | null
    far: number | null
}

export const DEFAULT_DEPTH_LOOK: DepthLook = {
    colormap: "turbo",
    near: null,
    far: null,
}
export const DEPTH_COLORMAPS = [
    "turbo",
    "magma",
    "plasma",
    "memworld",
    "grayscale",
]

/** Raw units → meters: 16UC1 is millimetres, 32FC1 meters; anything else (mono16) is treated as millimetres. */
export const depthScale = (encoding: string) => encoding === "32FC1" ? 1 : 0.001

/** Tracks the auto range so it doesn't flicker frame to frame. */
export class DepthRange {
    near = 0
    far = 1
    #seen = false
    update(image: DepthImage, look: DepthLook): [number, number] {
        if (look.near !== null && look.far !== null) {
            return [look.near, look.far]
        }
        const scale = depthScale(image.encoding)
        const data = image.data
        const step = Math.max(1, Math.floor(data.length / 4096))
        const samples: number[] = []
        for (let index = 0; index < data.length; index += step) {
            const value = data[index]
            if (value > 0 && Number.isFinite(value)) {
                samples.push(value * scale)
            }
        }
        if (samples.length) {
            samples.sort((a, b) => a - b)
            const low = samples[Math.floor(samples.length * 0.02)]
            const high = samples[Math.floor(samples.length * 0.98)]
            if (!this.#seen) {
                ;[this.near, this.far, this.#seen] = [low, high, true]
            } else {
                this.near += (low - this.near) * 0.2
                this.far += (high - this.far) * 0.2
            }
        }
        return [
            look.near ?? this.near,
            look.far ?? Math.max((look.near ?? this.near) + 0.01, this.far),
        ]
    }
}

// shared by both renderers: t = 0 at `near` → the hot end of the ramp
const RAMP_GLSL = /* glsl */ `
vec4 depthColor(float meters, vec2 range, sampler2D ramp) {
    if (!(meters > 0.0) || meters > 1e6) return vec4(0.0);
    float t = clamp((meters - range.x) / max(1e-6, range.y - range.x), 0.0, 1.0);
    return vec4(texture(ramp, vec2(1.0 - t, 0.5)).rgb, 1.0);
}
`

/** A WebGL2 canvas that draws depth images. */
export class DepthCanvas {
    readonly canvas = document.createElement("canvas")
    #gl: WebGL2RenderingContext
    #program: WebGLProgram
    #depth: WebGLTexture
    #ramp: WebGLTexture
    #rampName = ""
    #range = new DepthRange()

    constructor() {
        const gl = this.canvas.getContext("webgl2", { premultipliedAlpha: false })
        if (!gl) {
            throw new Error("WebGL2 is not available")
        }
        this.#gl = gl
        const compile = (type: number, source: string) => {
            const shader = gl.createShader(type)!
            gl.shaderSource(shader, source)
            gl.compileShader(shader)
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                throw new Error(gl.getShaderInfoLog(shader) ?? "shader")
            }
            return shader
        }
        const program = gl.createProgram()!
        gl.attachShader(
            program,
            compile(
                gl.VERTEX_SHADER,
                `#version 300 es
            out vec2 uv;
            void main() {
                vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
                uv = vec2(corner.x, 1.0 - corner.y);
                gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
            }`,
            ),
        )
        gl.attachShader(
            program,
            compile(
                gl.FRAGMENT_SHADER,
                `#version 300 es
            precision highp float;
            uniform sampler2D depth;
            uniform sampler2D ramp;
            uniform vec2 range;
            uniform float scale;
            in vec2 uv;
            out vec4 color;
            ${RAMP_GLSL}
            void main() { color = depthColor(texture(depth, uv).r * scale, range, ramp); }`,
            ),
        )
        gl.linkProgram(program)
        this.#program = program
        this.#depth = gl.createTexture()!
        this.#ramp = gl.createTexture()!
        for (const texture of [this.#depth, this.#ramp]) {
            gl.bindTexture(gl.TEXTURE_2D, texture)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        }
    }

    /** Draws one image; returns the range used (meters) for the panel's label. */
    draw(image: DepthImage, look: DepthLook): [number, number] {
        const gl = this.#gl
        const { width, height } = image
        if (!width || !height || image.data.length < width * height) {
            return [0, 0]
        }
        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width
            this.canvas.height = height
        }
        if (look.colormap !== this.#rampName) {
            this.#rampName = look.colormap
            const pixels = new Uint8Array(256 * 4)
            for (let index = 0; index < 256; index++) {
                pixels.set([
                    ...sampleGradient(look.colormap, index / 255).map(Math.round),
                    255,
                ], index * 4)
            }
            gl.bindTexture(gl.TEXTURE_2D, this.#ramp)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
            gl.texImage2D(
                gl.TEXTURE_2D,
                0,
                gl.RGBA,
                256,
                1,
                0,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                pixels,
            )
        }
        // one float channel; uint16 millimetres are converted on upload (no colour work on the CPU)
        const data = image.data instanceof Float32Array
            ? image.data
            : Float32Array.from(image.data.subarray(0, width * height))
        gl.bindTexture(gl.TEXTURE_2D, this.#depth)
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.R32F,
            width,
            height,
            0,
            gl.RED,
            gl.FLOAT,
            data,
        )
        const range = this.#range.update(image, look)
        gl.viewport(0, 0, width, height)
        gl.useProgram(this.#program)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, this.#depth)
        gl.uniform1i(gl.getUniformLocation(this.#program, "depth"), 0)
        gl.activeTexture(gl.TEXTURE1)
        gl.bindTexture(gl.TEXTURE_2D, this.#ramp)
        gl.uniform1i(gl.getUniformLocation(this.#program, "ramp"), 1)
        gl.uniform2f(
            gl.getUniformLocation(this.#program, "range"),
            range[0],
            range[1],
        )
        gl.uniform1f(
            gl.getUniformLocation(this.#program, "scale"),
            depthScale(image.encoding),
        )
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
        return range
    }
}

const rampTextures = new Map<string, THREE.DataTexture>()
/** The ramp as raw bytes (no colour-space conversion: the shader writes them straight out, like the panel's). */
function rampTexture(name: string): THREE.DataTexture {
    let texture = rampTextures.get(name)
    if (!texture) {
        const pixels = new Uint8Array(256 * 4)
        for (let index = 0; index < 256; index++) {
            pixels.set(
                [...sampleGradient(name, index / 255).map(Math.round), 255],
                index * 4,
            )
        }
        texture = new THREE.DataTexture(pixels, 256, 1)
        texture.magFilter = THREE.LinearFilter
        texture.needsUpdate = true
        rampTextures.set(name, texture)
    }
    return texture
}

/** The 3D projection's material: a depth texture coloured the same way. */
export class DepthMaterial {
    readonly material: THREE.ShaderMaterial
    #texture: THREE.DataTexture | null = null
    #range = new DepthRange()

    constructor() {
        this.material = new THREE.ShaderMaterial({
            glslVersion: THREE.GLSL3,
            transparent: true,
            side: THREE.DoubleSide,
            toneMapped: false,
            uniforms: {
                depth: { value: null },
                ramp: { value: rampTexture("turbo") },
                range: { value: new THREE.Vector2(0, 1) },
                scale: { value: 0.001 },
                opacity: { value: 1 },
            },
            vertexShader:
                /* glsl */ `out vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: /* glsl */ `
                uniform sampler2D depth;
                uniform sampler2D ramp;
                uniform vec2 range;
                uniform float scale;
                uniform float opacity;
                in vec2 vUv;
                ${RAMP_GLSL}
                void main() {
                    vec4 color = depthColor(texture(depth, vec2(vUv.x, 1.0 - vUv.y)).r * scale, range, ramp);
                    if (color.a == 0.0) discard;
                    gl_FragColor = vec4(color.rgb, opacity);
                }`,
        })
    }

    update(image: DepthImage, look: DepthLook) {
        const { width, height } = image
        const data = image.data instanceof Float32Array
            ? image.data
            : Float32Array.from(image.data.subarray(0, width * height))
        if (
            !this.#texture || this.#texture.image.width !== width ||
            this.#texture.image.height !== height
        ) {
            this.#texture?.dispose()
            this.#texture = new THREE.DataTexture(
                data,
                width,
                height,
                THREE.RedFormat,
                THREE.FloatType,
            )
            this.material.uniforms.depth.value = this.#texture
        } else {
            ;(this.#texture.image as { data: Float32Array }).data = data
        }
        this.#texture.needsUpdate = true
        const [near, far] = this.#range.update(image, look)
        this.material.uniforms.range.value.set(near, far)
        this.material.uniforms.scale.value = depthScale(image.encoding)
        this.material.uniforms.ramp.value = rampTexture(look.colormap)
    }

    dispose() {
        this.#texture?.dispose()
        this.material.dispose()
    }
}

// Ported unchanged from dim-controller (frontend/src/core/sceneData.ts): keep the two in step.
// A simulated world's description (dimos.scene_data.v1, what a SceneData module publishes on /scene_data) as three.js
// objects: a group per body, named by the body so its TF frame can move it, with its geoms and lights inside.
import * as THREE from "three"
import { grassFor } from "./grass.ts"

type V3 = [number, number, number]
type Q = [number, number, number, number]

export interface SceneGeom {
    name: string
    type: "plane" | "hfield" | "sphere" | "capsule" | "ellipsoid" | "cylinder" | "box" | "mesh"
    size: number[]
    pos: V3
    quat: Q
    rgba: [number, number, number, number]
    mesh?: string
    hfield?: string
    texture?: string
    /** its MuJoCo material's name, e.g. "grass_0" on a World Builder hill */
    material?: string
}
export interface SceneBody {
    name: string
    label: string
    pos: V3
    quat: Q
    mocap: boolean
    geoms: SceneGeom[]
    lights: { name: string; pos: V3; dir: V3; diffuse: V3; directional: boolean; castshadow: boolean; cutoff: number }[]
}
export interface SceneData {
    format: string
    id: string
    frame: string
    bodies: SceneBody[]
    meshes: Record<string, { vertices: string; faces: string; texcoords?: string; face_texcoords?: string }>
    hfields: Record<string, { nrow: number; ncol: number; size: number[]; heights: string }>
    textures: Record<string, { width: number; height: number; channels: number; pixels: string }>
}

function bytes(b64: string): Uint8Array {
    return Uint8Array.from(atob(b64), (char) => char.charCodeAt(0))
}
const floats = (b64: string) => {
    const raw = bytes(b64)
    return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
}
const uints = (b64: string) => {
    const raw = bytes(b64)
    return new Uint32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
}

/** a texture's mean color (its bytes are sRGB, like the DataTexture made from them) */
export function averageColor(pixels: Uint8Array, channels: number): THREE.Color {
    const sum = [0, 0, 0]
    const count = Math.floor(pixels.length / channels)
    for (let index = 0; index < count; index++) {
        for (let channel = 0; channel < 3; channel++) {
            sum[channel] += pixels[index * channels + Math.min(channel, channels - 1)]
        }
    }
    const mean = (channel: number) => (count ? sum[channel] / count / 255 : 1)
    return new THREE.Color().setRGB(mean(0), mean(1), mean(2), THREE.SRGBColorSpace)
}

/** MuJoCo's cylinders and capsules run along z; three's along y */
const Y_TO_Z = new THREE.Matrix4().makeRotationX(Math.PI / 2)

/** The world's three.js objects: a group per body (named by the body, for TF), geoms as meshes inside. */
export interface BuiltScene {
    root: THREE.Group
    bodies: Map<string, THREE.Group>
    lights: THREE.Light[]
    /** blades on each "grass*" height field, hidden until the layer shows them; `area` sets the count per density */
    grass: { mesh: THREE.InstancedMesh; area: number }[]
}

export function buildScene(data: SceneData): BuiltScene {
    const root = new THREE.Group()
    root.name = `scene:${data.id}`
    const bodies = new Map<string, THREE.Group>()
    const lights: THREE.Light[] = []
    const grass: BuiltScene["grass"] = []
    const meshCache = new Map<string, THREE.BufferGeometry>()
    const textureCache = new Map<string, THREE.Texture>()

    const meshGeometry = (name: string) => {
        let geometry = meshCache.get(name)
        if (!geometry) {
            const mesh = data.meshes[name]
            const vertices = floats(mesh.vertices)
            const faces = uints(mesh.faces)
            geometry = new THREE.BufferGeometry()
            if (mesh.texcoords && mesh.face_texcoords) {
                // texcoords are per face corner: unroll the triangles so each corner has its own uv
                const uv = floats(mesh.texcoords)
                const corners = uints(mesh.face_texcoords)
                const position = new Float32Array(faces.length * 3)
                const uvs = new Float32Array(faces.length * 2)
                for (let corner = 0; corner < faces.length; corner++) {
                    position.set(vertices.subarray(faces[corner] * 3, faces[corner] * 3 + 3), corner * 3)
                    // MuJoCo's v runs down the image; three's up
                    uvs[corner * 2] = uv[corners[corner] * 2]
                    uvs[corner * 2 + 1] = 1 - uv[corners[corner] * 2 + 1]
                }
                geometry.setAttribute("position", new THREE.BufferAttribute(position, 3))
                geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2))
            } else {
                geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3))
                geometry.setIndex(new THREE.BufferAttribute(faces, 1))
            }
            geometry.computeVertexNormals()
            meshCache.set(name, geometry)
        }
        return geometry
    }

    const hfieldGeometry = (name: string) => {
        const field = data.hfields[name]
        const [rx, ry, top] = field.size
        const heights = floats(field.heights)
        // a plane in xy, ncol x nrow samples; hfield row 0 is at -y, column 0 at -x
        const geometry = new THREE.PlaneGeometry(2 * rx, 2 * ry, field.ncol - 1, field.nrow - 1)
        const position = geometry.getAttribute("position") as THREE.BufferAttribute
        for (let index = 0; index < position.count; index++) {
            const row = field.nrow - 1 - Math.floor(index / field.ncol) // PlaneGeometry's rows run from +y down
            const col = index % field.ncol
            position.setZ(index, heights[row * field.ncol + col] * top)
        }
        geometry.computeVertexNormals()
        return geometry
    }

    const texture = (name: string) => {
        let made = textureCache.get(name)
        if (!made) {
            const source = data.textures[name]
            const pixels = bytes(source.pixels)
            const rgba = new Uint8Array(source.width * source.height * 4)
            for (let index = 0; index < source.width * source.height; index++) {
                for (let channel = 0; channel < 3; channel++) {
                    rgba[index * 4 + channel] = pixels[index * source.channels + Math.min(channel, source.channels - 1)]
                }
                rgba[index * 4 + 3] = source.channels === 4 ? pixels[index * 4 + 3] : 255
            }
            made = new THREE.DataTexture(rgba, source.width, source.height)
            made.colorSpace = THREE.SRGBColorSpace
            made.magFilter = THREE.NearestFilter
            made.flipY = true
            made.needsUpdate = true
            textureCache.set(name, made)
        }
        return made
    }

    const geomGeometry = (geom: SceneGeom): THREE.BufferGeometry | null => {
        const [a, b, c] = geom.size
        switch (geom.type) {
            case "box":
                return new THREE.BoxGeometry(2 * a, 2 * b, 2 * c)
            case "sphere":
                return new THREE.SphereGeometry(a, 24, 16)
            case "ellipsoid":
                return new THREE.SphereGeometry(1, 24, 16).scale(a, b, c)
            case "cylinder":
                return new THREE.CylinderGeometry(a, a, 2 * b, 24).applyMatrix4(Y_TO_Z)
            case "capsule":
                return new THREE.CapsuleGeometry(a, 2 * b, 8, 16).applyMatrix4(Y_TO_Z)
            case "mesh":
                return geom.mesh && data.meshes[geom.mesh] ? meshGeometry(geom.mesh) : null
            case "hfield":
                return geom.hfield && data.hfields[geom.hfield] ? hfieldGeometry(geom.hfield) : null
            default:
                return null // the plane: the view has its own ground grid
        }
    }

    for (const body of data.bodies) {
        const group = new THREE.Group()
        group.name = body.name
        group.userData = { label: body.label, mocap: body.mocap }
        group.position.set(...body.pos)
        group.quaternion.set(...body.quat)
        for (const geom of body.geoms) {
            const geometry = geomGeometry(geom)
            if (!geometry) {
                continue
            }
            const [r, g, b, alpha] = geom.rgba
            const material = new THREE.MeshStandardMaterial({
                // MuJoCo rgba is display (sRGB) color, not linear
                color: new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace),
                map: geom.texture && data.textures[geom.texture] ? texture(geom.texture) : null,
                roughness: 0.85,
                metalness: 0,
                transparent: alpha < 1,
                opacity: alpha,
            })
            if (material.map) {
                material.color.set(0xffffff)
            }
            const mesh = new THREE.Mesh(geometry, material)
            mesh.name = geom.name
            mesh.userData.baseOpacity = alpha
            mesh.position.set(...geom.pos)
            mesh.quaternion.set(...geom.quat)
            mesh.castShadow = true
            mesh.receiveShadow = true
            group.add(mesh)
            if (geom.type === "hfield" && geom.hfield && geom.material?.startsWith("grass")) {
                const field = data.hfields[geom.hfield]
                // a textured hill (World Builder's speckled grass) carries its green in the texture, not its rgba
                const source = geom.texture ? data.textures[geom.texture] : undefined
                const green = source ? averageColor(bytes(source.pixels), source.channels) : new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace)
                const blades = grassFor({ ...field, heights: floats(field.heights) }, green)
                blades.mesh.visible = false
                mesh.add(blades.mesh)
                grass.push(blades)
            }
        }
        for (const light of body.lights) {
            const color = new THREE.Color(...light.diffuse)
            const made = light.directional
                ? new THREE.DirectionalLight(color, 1.5)
                : light.cutoff < 90
                ? new THREE.SpotLight(color, 20, 0, THREE.MathUtils.degToRad(light.cutoff), 0.3, 1.5)
                : new THREE.PointLight(color, 20, 0, 1.5)
            made.position.set(...light.pos)
            if (made instanceof THREE.DirectionalLight || made instanceof THREE.SpotLight) {
                made.target.position.set(light.pos[0] + light.dir[0], light.pos[1] + light.dir[1], light.pos[2] + light.dir[2])
                group.add(made.target)
            }
            made.visible = false
            group.add(made)
            lights.push(made)
        }
        root.add(group)
        bodies.set(body.name, group)
    }
    return { root, bodies, lights, grass }
}

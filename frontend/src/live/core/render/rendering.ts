// Rendering choices that apply to every point layer: the default point style (a layer can override it), cube shading, and the
// automatic fallback that swaps splats for cubes when they can't keep up.
import { persistentStore, Store } from "../store.ts"
import type { CubeShade, PointStyle } from "./pointMaterial.ts"

// v2: the default moved from glow to cubes, and a stored "glow" from before that shouldn't hide the new default
export const rendering = persistentStore<
    { pointStyle: PointStyle; cubeShade: CubeShade }
>("lv.rendering.v2", { pointStyle: "voxel", cubeShade: "soft" })

/** Set while splats are being drawn as cubes because frames took longer than FRAME_BUDGET_MS for a while. */
export const splatFallback = new Store<{ active: boolean; frameMs: number }>({
    active: false,
    frameMs: 0,
})

/** The style a layer draws with: its own choice, else the global default, with the fallback applied. */
export function resolveStyle(style: PointStyle | "default"): PointStyle {
    const chosen = style === "default" ? rendering.get().pointStyle : style
    return chosen === "splat" && splatFallback.get().active ? "voxel" : chosen
}

export const FRAME_BUDGET_MS = 16

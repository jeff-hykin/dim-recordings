// The point the camera follows, smoothed on the render side: poses arrive at 10-20 Hz but frames at 60-120, so a
// camera glued to the latest pose stands still for several frames and then jumps. A critically damped spring
// (Unity's SmoothDamp) glides between poses instead; a big jump (a teleport, a new session) snaps.

export type Vec3 = [number, number, number]

/** how far behind the spring settles, seconds (~ its lag at a steady speed) */
const SMOOTH_SECONDS = 0.15
/** a jump this far (meters), or a gap this long (seconds), is a new place: no gliding there */
const SNAP_METERS = 2
const SNAP_GAP_SECONDS = 1

export class SmoothFollow {
    #at: Vec3 | null = null
    #velocity: Vec3 = [0, 0, 0]

    /** Where the camera should be looking this frame, given the robot's latest position and the frame time. */
    step(target: Vec3, dtSeconds: number): Vec3 {
        const at = this.#at
        if (
            !at || dtSeconds > SNAP_GAP_SECONDS ||
            Math.hypot(target[0] - at[0], target[1] - at[1], target[2] - at[2]) >
                SNAP_METERS
        ) {
            this.#velocity = [0, 0, 0]
            this.#at = [...target]
            return this.#at
        }
        const omega = 2 / SMOOTH_SECONDS
        const x = omega * dtSeconds
        const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x)
        for (let axis = 0; axis < 3; axis++) {
            const change = at[axis] - target[axis]
            const pull = (this.#velocity[axis] + omega * change) * dtSeconds
            this.#velocity[axis] = (this.#velocity[axis] - omega * pull) * decay
            at[axis] = target[axis] + (change + pull) * decay
        }
        return at
    }

    reset() {
        this.#at = null
    }
}

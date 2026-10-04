// The robot profiles the picker offers; the first is the default. A fork adds its own file here (or edits one).
import go2 from "./go2.ts"
import r1 from "./r1.ts"
import drone from "./drone.ts"
import type { RobotProfile } from "./types.ts"

export const profiles: RobotProfile[] = [go2, r1, drone]

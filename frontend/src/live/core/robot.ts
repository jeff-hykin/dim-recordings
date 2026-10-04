// The robot's latest pose in the fixed frame from any pose/odometry layer, for following it when no TF frame
// names the robot. The first topic to report keeps it until it goes away.
import type { Matrix4 } from "three"

class RobotPose {
    matrix: Matrix4 | null = null
    source: string | null = null
    report(source: string, matrix: Matrix4) {
        if (this.source === null || this.source === source) {
            this.source = source
            this.matrix = matrix
        }
    }
    forget(source: string) {
        if (this.source === source) {
            this.source = null
            this.matrix = null
        }
    }
}

export const robotPose = new RobotPose()

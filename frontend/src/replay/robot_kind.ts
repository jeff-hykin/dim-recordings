// Which robot a recording is of, so the Replayer draws its stand-in (dimos-react's ROBOT_KINDS) or none at all. The
// Controller's rule (its core/robotType.ts) asks the running blueprint; a recording carries no blueprint, so the
// evidence is the recording itself, first match wins:
// 1. its URDF (a urdf_info stream, as dimos's UrdfManager publishes it): the robot's name, then its link names;
// 2. its TF frame names (an R1 Pro's torso_link4 / head_link / left_arm_link7, a Go2's go2_odom / FL_hip, a G1's pelvis);
// 3. its file name (go2 → dog, r1 / r1pro / alfred → wheeled, g1 → humanoid, drone);
// 4. nothing: null, and no model is drawn (never a dog by default).

export type RobotKind = "dog" | "humanoid" | "wheeled" | "drone"

export interface RobotKindAnswer {
    kind: RobotKind
    /** why, in words, for the Settings hint */
    reason: string
}

const FRAME_RULES: [RegExp, RobotKind, string][] = [
    [
        /^torso_link\d|^(left|right)_arm_link\d|^steer_motor_link\d|^wheel_motor_link\d|^camera_head_(left|right)_link$|^lidar_chassis_left_link$|^(left|right)_d405_link$/,
        "wheeled",
        "Galaxea R1 Pro",
    ],
    [/^go2_|^(FL|FR|RL|RR)_(hip|thigh|calf|foot)$/, "dog", "Unitree Go2"],
    [
        /^pelvis$|^(left|right)_(hip|knee|ankle)_(pitch|roll|yaw)_link$|^g1_/,
        "humanoid",
        "Unitree G1",
    ],
]

const NAME_RULES: [RegExp, RobotKind][] = [
    [/drone/, "drone"],
    [/\bg1\b|humanoid/, "humanoid"],
    [/\br1\b|r1pro|r1 pro|alfred|galaxea/, "wheeled"],
    [/go2|spot|m20|dog|quadruped/, "dog"],
]

/** A kind from a name (a file, a blueprint, a URDF's robot name), or null. */
export function kindFromName(name: string): RobotKind | null {
    const words = name.toLowerCase().replace(/[_\-.]+/g, " ")
    return NAME_RULES.find(([pattern]) => pattern.test(words))?.[1] ?? null
}

/** A kind from frame (or URDF link) names, or null; `of` names where they came from. */
export function kindFromFrames(
    frames: Iterable<string>,
    of = "TF frame",
): RobotKindAnswer | null {
    const names = [...frames].map((frame) => frame.replace(/^\/+/, "").split("/").pop()!)
    for (const [pattern, kind, robot] of FRAME_RULES) {
        const hit = names.find((name) => pattern.test(name))
        if (hit) {
            return { kind, reason: `${robot} ${of} ${hit}` }
        }
    }
    return null
}

/** A kind from a URDF's XML: its <robot name>, else its link names. */
export function kindFromUrdf(xml: string): RobotKindAnswer | null {
    const name = xml.match(/<robot\b[^>]*\bname\s*=\s*"([^"]*)"/)?.[1] ?? ""
    const byName = kindFromName(name)
    if (byName) {
        return { kind: byName, reason: `the recording's URDF (robot ${name})` }
    }
    const links = [...xml.matchAll(/<link\b[^>]*\bname\s*=\s*"([^"]*)"/g)].map((
        match,
    ) => match[1])
    return kindFromFrames(links, "URDF link")
}

/** The recording's robot (the rule at the top of this file), or null when nothing identifies it. */
export function recordingRobotKind(
    evidence: { urdf?: string | null; frames: Iterable<string>; name: string },
): RobotKindAnswer | null {
    const fromUrdf = evidence.urdf ? kindFromUrdf(evidence.urdf) : null
    if (fromUrdf) {
        return fromUrdf
    }
    const fromFrames = kindFromFrames(evidence.frames)
    if (fromFrames) {
        return fromFrames
    }
    const fromName = kindFromName(evidence.name)
    return fromName ? { kind: fromName, reason: `the file's name (${evidence.name})` } : null
}

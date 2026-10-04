// Can Foxglove show this recording? Foxglove reads ROS 2 CDR with an attached schema; a raw-LCM channel loads and
// draws nothing (dtk data check / tools/mcap_check.js). The rule: an .mcap whose point cloud, image and camera_info
// channels are all CDR with a schema. Tests: foxglove_test.ts.
import type { Inspection } from "./inspect.ts"

const DRAWN = /(PointCloud2|(^|\.)Image|CompressedImage|CameraInfo)$/

export type Verdict = { ok: boolean; reason: string }

export function foxgloveVerdict(format: string, inspection: Pick<Inspection, "streams"> | null): Verdict {
    if (format !== "mcap") {
        return { ok: false, reason: "Foxglove opens .mcap files; convert this one to .mcap first" }
    }
    if (!inspection) {
        return { ok: false, reason: "still reading the file" }
    }
    const visual = inspection.streams.filter((stream) => DRAWN.test(stream.type))
    const bad = visual.filter((stream) => stream.encoding !== "cdr" || !stream.hasSchema)
    if (bad.length) {
        const names = bad.slice(0, 3).map((stream) =>
            `${stream.name} (${stream.encoding !== "cdr" ? stream.encoding || "no encoding" : "no schema"})`
        )
        return {
            ok: false,
            reason: `Foxglove can't draw ${names.join(", ")}${bad.length > 3 ? ` and ${bad.length - 3} more` : ""}: ` +
                "it needs CDR with a schema (convert with `dtk data lcm_to_cdr`)",
        }
    }
    return {
        ok: true,
        reason: visual.length
            ? "its point cloud, image and camera_info channels are CDR"
            : "no image or point cloud channels to check",
    }
}

/** Where Foxglove is installed, or null. */
export function findFoxglove(
    os = Deno.build.os,
    exists = (path: string) => {
        try {
            Deno.statSync(path)
            return true
        } catch {
            return false
        }
    },
    onPath = (name: string) => which(name),
): { command: string[] } | null {
    if (os === "darwin") {
        for (const app of ["/Applications/Foxglove.app", `${Deno.env.get("HOME")}/Applications/Foxglove.app`]) {
            if (exists(app)) {
                return { command: ["open", "-a", app] }
            }
        }
    }
    for (const name of ["foxglove", "foxglove-studio"]) {
        const found = onPath(name)
        if (found) {
            return { command: [found] }
        }
    }
    return null
}

/** A program on PATH (plus the usual spots apps launched from a GUI miss), or null. */
export function which(name: string): string | null {
    const home = Deno.env.get("HOME") ?? ""
    const dirs = [
        ...(Deno.env.get("PATH") ?? "").split(":"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        `${home}/.cargo/bin`,
        `${home}/.deno/bin`,
        `${home}/.local/bin`,
        "/snap/bin",
    ]
    for (const dir of dirs.filter(Boolean)) {
        try {
            const stat = Deno.statSync(`${dir}/${name}`)
            if (stat.isFile && ((stat.mode ?? 0o111) & 0o111)) {
                return `${dir}/${name}`
            }
        } catch {
            // not here
        }
    }
    return null
}

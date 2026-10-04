// The TF tree as an indented list, what's wrong with it, and which frame the view is fixed to.
import { useEffect, useState } from "react"
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import type { TfSnapshot } from "../core/tf.ts"
import { Field } from "./controls.tsx"

function Tree(
    { snapshot, frame, depth, seen }: {
        snapshot: TfSnapshot
        frame: string
        depth: number
        seen: Set<string>
    },
) {
    if (seen.has(frame) || depth > 64) {
        return null
    }
    seen.add(frame)
    const edge = snapshot.edges.find((other) => other.child === frame)
    const stale = snapshot.problems.stale.includes(frame)
    const children = snapshot.edges.filter((other) => other.parent === frame).map(
        (other) => other.child,
    ).sort()
    return (
        <>
            <div
                className={`tf-frame ${stale ? "stale" : ""}`}
                style={{ paddingLeft: depth * 14 }}
            >
                <span>{frame}</span>
                {edge && (
                    <span className="tf-age">
                        {edge.isStatic ? "static" : `${Math.round(edge.ageMs)} ms`}
                    </span>
                )}
            </div>
            {children.map((child) => (
                <Tree
                    key={child}
                    snapshot={snapshot}
                    frame={child}
                    depth={depth + 1}
                    seen={seen}
                />
            ))}
        </>
    )
}

export function TfPanel({ app }: { app: ViewerApp }) {
    const view = useStore(app.settings)
    const frameInfo = useStore(app.frameInfo)
    const [snapshot, setSnapshot] = useState<TfSnapshot>(() => app.tf.snapshot(frameInfo.fixedFrame))
    useEffect(() => {
        const timer = setInterval(
            () => setSnapshot(app.tf.snapshot(app.frameInfo.get().fixedFrame)),
            1000,
        )
        return () => clearInterval(timer)
    }, [app])
    const { problems } = snapshot
    return (
        <div className="tf-panel">
            <Field
                label="Fixed frame"
                hint="everything is drawn relative to this frame"
            >
                <select
                    className="dim-select"
                    value={view.fixedFrame}
                    onChange={(event) => app.settings.update({ fixedFrame: event.target.value })}
                >
                    <option value="">auto ({frameInfo.fixedFrame})</option>
                    {snapshot.frames.map((frame) => <option key={frame} value={frame}>{frame}</option>)}
                </select>
            </Field>
            <p className="hint">
                Robot frame: {app.profile.baseFrame} {frameInfo.robotFound ? "✓" : "(not in TF yet)"}
            </p>
            {problems.doubleParent.map(([child, parents]) => (
                <p key={child} className="problem">
                    {child} has {parents.length} parents: {parents.join(", ")}
                </p>
            ))}
            {problems.roots.length > 1 && (
                <p className="problem">
                    {problems.roots.length} separate trees (roots{" "}
                    {problems.roots.join(", ")}): frames in different trees can't be placed relative to each other
                </p>
            )}
            {problems.cycle.length > 0 && <p className="problem">cycle through {problems.cycle.join(", ")}</p>}
            {problems.stale.length > 0 && <p className="problem">stopped updating: {problems.stale.join(", ")}</p>}
            {!snapshot.frames.length && <p className="empty">no tf yet</p>}
            <div className="tf-tree">
                {problems.roots.map((root) => (
                    <Tree
                        key={root}
                        snapshot={snapshot}
                        frame={root}
                        depth={0}
                        seen={new Set()}
                    />
                ))}
            </div>
        </div>
    )
}

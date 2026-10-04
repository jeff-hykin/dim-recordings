// The Replayer's timeline, docked at the bottom: play / pause, speed, loop, the time, and the scrubber. Expanded, it
// shows one row per stream with a tick wherever the stream has messages (like Rerun's timeline), on the same time
// axis as the scrubber; a row's switch draws or hides that stream's layer, and its menu renames, duplicates or
// deletes the stream in the file. Scrolling over the rows zooms the axis around the cursor; dragging any lane scrubs.
import { useEffect, useMemo, useRef, useState } from "react"
import type { ViewerApp } from "../live/core/app.ts"
import { useStore } from "../live/core/store.ts"
import { dimosKey, type StreamInfo } from "../live/core/transport.ts"
import { Icon } from "../live/ui/icons.tsx"
import { createPortal } from "react-dom"
import { ConfirmDialog, Dialog, type MenuItem, toast } from "../ui.tsx"
import { clock, type Overview, replayApi, type Timeline as TimelineData } from "./api.ts"

const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4, 8, 16]
const KIND_LABEL: Record<StreamInfo["kind"], string> = {
    image: "camera",
    cloud: "point cloud",
    tf: "tf",
    pose: "pose",
    info: "camera info",
    other: "",
}

type View = { from: number; to: number }

export function Timeline({ app, overview, expanded, onExpanded, onEdited }: {
    app: ViewerApp
    overview: Overview
    expanded: boolean
    onExpanded: (expanded: boolean) => void
    /** a stream edit finished: the page reloads the recording */
    onEdited: () => void
}) {
    const head = useStore(app.connection.playhead)
    const span = Math.max(1e-6, overview.end - overview.start)
    const [view, setView] = useState<View>({
        from: overview.start,
        to: overview.end,
    })
    const zoomed = view.from > overview.start + 1e-6 ||
        view.to < overview.end - 1e-6
    const [rows, setRows] = useState<TimelineData | null>(null)
    const [hover, setHover] = useState<{ x: number; t: number } | null>(null)
    const resumeAfterScrub = useRef(false)
    const connection = app.connection

    // per-stream ticks for the visible window (re-asked when zoomed)
    useEffect(() => {
        if (!expanded) {
            return
        }
        let gone = false
        const timer = setTimeout(() => {
            const url = `api/replay/${
                encodeURIComponent(overview.id)
            }/timeline?bins=1500&from=${view.from}&to=${view.to}`
            fetch(url).then((response) => response.json()).then((data) => !gone && setRows(data)).catch(() => {})
        }, 120)
        return () => {
            gone = true
            clearTimeout(timer)
        }
    }, [expanded, overview.id, view.from, view.to])

    // keyboard: space plays / pauses, arrows step (shift: 10 s), Home / End (not while typing)
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement
            if (
                target.closest("input, select, textarea, [contenteditable]") ||
                event.metaKey || event.ctrlKey
            ) {
                return
            }
            const t = connection.playhead.get().t
            if (event.code === "Space") {
                event.preventDefault()
                connection.playhead.get().playing ? connection.pause() : connection.play()
            } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault()
                connection.seek(
                    t + (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 10 : 1),
                )
            } else if (event.key === "Home") {
                connection.seek(overview.start)
            } else if (event.key === "End") {
                connection.seek(overview.end)
            }
        }
        // a focused button would also take the space as a click (on keyup): space is play / pause only
        const onKeyUp = (event: KeyboardEvent) => {
            if (
                event.code === "Space" &&
                !(event.target as HTMLElement).closest("input, select, textarea, [contenteditable]")
            ) {
                event.preventDefault()
            }
        }
        addEventListener("keydown", onKey)
        addEventListener("keyup", onKeyUp)
        return () => {
            removeEventListener("keydown", onKey)
            removeEventListener("keyup", onKeyUp)
        }
    }, [connection, overview.start, overview.end])

    const timeAt = (lane: HTMLElement, clientX: number) => {
        const box = lane.getBoundingClientRect()
        const fraction = Math.min(
            1,
            Math.max(0, (clientX - box.left) / Math.max(1, box.width)),
        )
        return view.from + fraction * (view.to - view.from)
    }
    const scrubProps = {
        onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
            if (event.button !== 0) {
                return
            }
            const lane = event.currentTarget
            lane.setPointerCapture(event.pointerId)
            resumeAfterScrub.current = connection.playhead.get().playing
            connection.playhead.update({
                scrubbing: true,
                playing: false,
                t: timeAt(lane, event.clientX),
            })
        },
        onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
            const lane = event.currentTarget
            const t = timeAt(lane, event.clientX)
            setHover({ x: event.clientX - lane.getBoundingClientRect().left, t })
            if (
                connection.playhead.get().scrubbing &&
                lane.hasPointerCapture(event.pointerId)
            ) {
                connection.playhead.update({ t })
            }
        },
        onPointerUp: (event: React.PointerEvent<HTMLElement>) => {
            if (!connection.playhead.get().scrubbing) {
                return
            }
            event.currentTarget.releasePointerCapture(event.pointerId)
            connection.playhead.update({
                scrubbing: false,
                playing: resumeAfterScrub.current,
            })
        },
        onPointerLeave: () => setHover(null),
        onWheel: (event: React.WheelEvent<HTMLElement>) => {
            if (!expanded && !event.ctrlKey && !event.metaKey) {
                return
            }
            // zoom around the cursor; horizontal scroll pans
            const lane = event.currentTarget
            const at = timeAt(lane, event.clientX)
            const width = view.to - view.from
            if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
                const shift = (event.deltaX / Math.max(1, lane.clientWidth)) * width
                const from = Math.min(
                    overview.end - width,
                    Math.max(overview.start, view.from + shift),
                )
                setView({ from, to: from + width })
                return
            }
            const factor = Math.exp(event.deltaY * 0.002)
            const next = Math.min(span, Math.max(0.05, width * factor))
            let from = at - ((at - view.from) / width) * next
            from = Math.min(overview.end - next, Math.max(overview.start, from))
            setView({ from, to: from + next })
        },
    }
    const percent = (t: number) => `${((t - view.from) / Math.max(1e-9, view.to - view.from)) * 100}%`
    const inView = head.t >= view.from && head.t <= view.to

    return (
        <section
            className={`timeline dim-panel ${expanded ? "expanded" : ""}`}
            data-testid="timeline"
            aria-label="Timeline"
        >
            <div className="tl-bar">
                <div className="tl-controls">
                    <button
                        type="button"
                        className="dim-btn primary icon tl-play"
                        title={head.playing ? "Pause (space)" : "Play (space)"}
                        aria-label={head.playing ? "Pause" : "Play"}
                        data-testid="play"
                        onClick={() => (head.playing ? connection.pause() : connection.play())}
                    >
                        <Icon name={head.playing ? "pause" : "play"} size={16} />
                    </button>
                    <span
                        className="tl-time dim-mono"
                        data-testid="time"
                        title="time since the recording's start / its length"
                    >
                        <span className="now">{clock(head.t - overview.start)}</span>
                        <span className="muted">/ {clock(span)}</span>
                    </span>
                    <select
                        className="dim-select tl-speed"
                        aria-label="Speed"
                        title="Playback speed"
                        value={String(head.speed)}
                        onChange={(event) => connection.playhead.update({ speed: Number(event.target.value) })}
                    >
                        {SPEEDS.map((speed) => <option key={speed} value={speed}>{speed}×</option>)}
                    </select>
                    <button
                        type="button"
                        className={`dim-btn sm ghost tl-loop ${head.loop ? "on" : ""}`}
                        aria-pressed={head.loop}
                        title="Loop: start over at the end"
                        onClick={() => connection.playhead.update({ loop: !head.loop })}
                    >
                        <Icon name="refresh" size={14} />
                    </button>
                    <button
                        type="button"
                        className={`dim-btn sm ghost tl-expand ${expanded ? "on" : ""}`}
                        aria-expanded={expanded}
                        title={expanded ? "Hide the per-stream rows" : "Show a row per stream"}
                        data-testid="expand"
                        onClick={() => onExpanded(!expanded)}
                    >
                        <Icon name={expanded ? "chevron-down" : "chevron-up"} size={14} />
                        <span>Streams</span>
                    </button>
                    {zoomed && (
                        <button
                            type="button"
                            className="dim-btn sm ghost"
                            title="Show the whole recording"
                            onClick={() => setView({ from: overview.start, to: overview.end })}
                        >
                            Fit
                        </button>
                    )}
                </div>
                <div
                    className="tl-lane tl-track"
                    data-testid="scrubber"
                    {...scrubProps}
                >
                    <div className="tl-rail" />
                    {inView && <div className="tl-fill" style={{ width: percent(head.t) }} />}
                    {inView && (
                        <div
                            className={`tl-handle ${head.scrubbing ? "active" : ""}`}
                            style={{ left: percent(head.t) }}
                        />
                    )}
                    {hover && (
                        <span className="tl-hover dim-mono" style={{ left: hover.x }}>
                            {clock(hover.t - overview.start)}
                        </span>
                    )}
                    {zoomed && (
                        <span className="tl-window dim-mono">
                            {clock(view.from - overview.start)} – {clock(view.to - overview.start)}
                        </span>
                    )}
                </div>
            </div>
            {expanded && (
                <div className="tl-rows" data-testid="stream-rows">
                    {overview.streams.map((stream) => (
                        <StreamRow
                            key={stream.name}
                            app={app}
                            overview={overview}
                            stream={stream}
                            row={rows?.streams.find((other) => other.name === stream.name) ??
                                null}
                            bins={rows?.bins ?? 0}
                            view={view}
                            playhead={inView ? percent(head.t) : null}
                            scrubProps={scrubProps}
                            onEdited={onEdited}
                        />
                    ))}
                </div>
            )}
        </section>
    )
}

function StreamRow(
    { app, overview, stream, row, bins, view, playhead, scrubProps, onEdited }: {
        app: ViewerApp
        overview: Overview
        stream: StreamInfo
        row: TimelineData["streams"][number] | null
        bins: number
        view: View
        playhead: string | null
        scrubProps: Record<string, unknown>
        onEdited: () => void
    },
) {
    const canvas = useRef<HTMLCanvasElement>(null)
    const entries = useStore(app.layers.entries).list
    const key = dimosKey(stream.name, stream.type)
    const layer = entries.find((entry) => entry.topic.key === key)
    const [dialog, setDialog] = useState<
        "rename" | "delete" | "duplicate" | null
    >(null)
    const [busy, setBusy] = useState(false)

    // the ticks: exact times when the stream is small, else the backend's per-slice counts
    useEffect(() => {
        const element = canvas.current
        if (!element) {
            return
        }
        const draw = () => {
            const ratio = devicePixelRatio || 1
            const width = Math.max(1, Math.round(element.clientWidth * ratio))
            const height = Math.max(1, Math.round(element.clientHeight * ratio))
            element.width = width
            element.height = height
            const context = element.getContext("2d")!
            context.clearRect(0, 0, width, height)
            if (!row) {
                return
            }
            const style = getComputedStyle(element)
            context.fillStyle = style.getPropertyValue("--tick").trim() ||
                style.color
            const range = Math.max(1e-9, view.to - view.from)
            if (row.times) {
                for (const t of row.times) {
                    if (t < view.from || t > view.to) {
                        continue
                    }
                    const x = Math.round(((t - view.from) / range) * width)
                    context.globalAlpha = 0.9
                    context.fillRect(x, height * 0.2, Math.max(1, ratio), height * 0.6)
                }
            } else if (bins) {
                const most = Math.max(1, ...row.counts)
                const slice = width / bins
                for (let bin = 0; bin < bins; bin++) {
                    const count = row.counts[bin]
                    if (!count) {
                        continue
                    }
                    context.globalAlpha = 0.35 + 0.65 * Math.min(1, count / most)
                    context.fillRect(
                        Math.floor(bin * slice),
                        height * 0.2,
                        Math.max(ratio, Math.ceil(slice)),
                        height * 0.6,
                    )
                }
            }
            context.globalAlpha = 1
        }
        draw()
        const observer = new ResizeObserver(draw)
        observer.observe(element)
        return () => observer.disconnect()
    }, [row, bins, view.from, view.to])

    const run = async (
        label: string,
        action: () => Promise<{ seconds: number }>,
    ) => {
        setBusy(true)
        try {
            const result = await action()
            toast(`${label} (${result.seconds.toFixed(1)} s)`, "ok")
            onEdited()
        } catch (error) {
            toast(String((error as Error).message ?? error), "danger")
        } finally {
            setBusy(false)
        }
    }
    const locked = !overview.editable
    const lockedHint =
        "this recording is a link to a file outside the recordings folder: duplicate the recording to edit a copy"
    const hz = stream.count > 1 && stream.end !== null && stream.start !== null &&
            stream.end > stream.start
        ? `${((stream.count - 1) / (stream.end - stream.start)).toFixed(1)} Hz`
        : ""
    return (
        <div
            className={`tl-row ${layer?.enabled ? "drawn" : ""} ${busy ? "busy" : ""}`}
            data-stream={stream.name}
        >
            <div className="tl-name">
                {layer
                    ? (
                        <button
                            type="button"
                            className={`dim-btn icon ghost tl-eye ${layer.enabled ? "on" : ""}`}
                            title={layer.enabled ? `Hide ${stream.name}` : `Draw ${stream.name}`}
                            aria-pressed={layer.enabled}
                            onClick={() => app.layers.setEnabled(key, !layer.enabled)}
                        >
                            <Icon name="eye" size={14} />
                        </button>
                    )
                    : <span className="tl-eye-space" />}
                <span
                    className="tl-stream dim-mono"
                    title={`${stream.name} · ${stream.type} (${stream.encoding})`}
                >
                    {stream.name}
                </span>
                <span className="tl-meta muted">
                    {KIND_LABEL[stream.kind] || stream.type}
                </span>
                <span className="tl-count dim-mono muted" title={hz}>
                    {stream.count.toLocaleString()}
                </span>
                <RowMenu
                    testId={`stream-menu-${stream.name}`}
                    items={[
                        { heading: stream.name },
                        {
                            label: "Rename…",
                            disabled: locked || busy,
                            hint: locked ? lockedHint : "in place, in the file",
                            onSelect: () => setDialog("rename"),
                        },
                        {
                            label: "Duplicate…",
                            disabled: locked || busy,
                            hint: locked ? lockedHint : "a copy under a new name, in the file",
                            onSelect: () => setDialog("duplicate"),
                        },
                        { separator: true },
                        {
                            label: "Delete…",
                            danger: true,
                            disabled: locked || busy,
                            hint: locked ? lockedHint : "removes its messages from the file",
                            onSelect: () => setDialog("delete"),
                        },
                    ]}
                />
            </div>
            <div className="tl-lane" {...scrubProps}>
                <canvas ref={canvas} className="tl-ticks" />
                {playhead && <div className="tl-cursor" style={{ left: playhead }} />}
            </div>
            {(dialog === "rename" || dialog === "duplicate") && (
                <NameDialog
                    title={dialog === "rename" ? `Rename ${stream.name}` : `Duplicate ${stream.name}`}
                    action={dialog === "rename" ? "Rename" : "Duplicate"}
                    initial={dialog === "rename" ? stream.name : `${stream.name}_copy`}
                    taken={overview.streams.map((other) => other.name)}
                    note={overview.format === "mcap"
                        ? "Edits the .mcap in place: it's rewritten beside itself and swapped in, no copy is left."
                        : "Edits the .db in place."}
                    onClose={() => setDialog(null)}
                    onSubmit={(name) =>
                        dialog === "rename"
                            ? run(
                                `Renamed ${stream.name} → ${name}`,
                                () => replayApi.renameStream(overview.id, stream.name, name),
                            )
                            : run(
                                `Duplicated ${stream.name} → ${name}`,
                                () => replayApi.duplicateStream(overview.id, stream.name, name),
                            )}
                />
            )}
            {dialog === "delete" && (
                <ConfirmDialog
                    title={`Delete ${stream.name}?`}
                    body={
                        <p>
                            Its {stream.count.toLocaleString()} messages are removed from{" "}
                            <span className="dim-mono">{overview.name}</span>. This can't be undone.
                        </p>
                    }
                    action="Delete stream"
                    danger
                    onConfirm={() =>
                        run(`Deleted ${stream.name}`, () => replayApi.deleteStream(overview.id, stream.name))}
                    onClose={() => setDialog(null)}
                />
            )}
        </div>
    )
}

function NameDialog({ title, action, initial, taken, note, onSubmit, onClose }: {
    title: string
    action: string
    initial: string
    /** names already in the recording (a new name can't be one) */
    taken: string[]
    note: string
    onSubmit: (name: string) => void
    onClose: () => void
}) {
    const [value, setValue] = useState(initial)
    const input = useRef<HTMLInputElement>(null)
    useEffect(() => input.current?.select(), [])
    const valid = useMemo(() => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.trim()), [value])
    const exists = taken.includes(value.trim())
    const submit = () => {
        if (valid && !exists) {
            onSubmit(value.trim())
            onClose()
        }
    }
    return (
        <Dialog title={title} onClose={onClose}>
            <div className="rename-field">
                <input
                    ref={input}
                    className="dim-input mono"
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    onKeyDown={(event) => event.key === "Enter" && submit()}
                    aria-label="stream name"
                />
            </div>
            <p className="muted small">
                {valid ? note : "Letters, digits and _ only, not starting with a digit."}
            </p>
            <div className="dialog-actions">
                <button type="button" className="dim-btn ghost" onClick={onClose}>
                    Cancel
                </button>
                <button
                    type="button"
                    className="dim-btn primary"
                    disabled={!valid || exists}
                    onClick={submit}
                >
                    {action}
                </button>
            </div>
        </Dialog>
    )
}

/** A stream row's menu. It opens upward over everything (the rows scroll, which would clip a dropdown inside them). */
function RowMenu({ items, testId }: { items: MenuItem[]; testId?: string }) {
    const [at, setAt] = useState<{ left: number; bottom: number } | null>(null)
    const button = useRef<HTMLButtonElement>(null)
    useEffect(() => {
        if (!at) {
            return
        }
        const close = (event: Event) => {
            if (!(event.target as HTMLElement).closest?.(".row-menu, .tl-menu")) {
                setAt(null)
            }
        }
        const onKey = (event: KeyboardEvent) => event.key === "Escape" && setAt(null)
        addEventListener("pointerdown", close, true)
        addEventListener("keydown", onKey)
        return () => {
            removeEventListener("pointerdown", close, true)
            removeEventListener("keydown", onKey)
        }
    }, [at])
    return (
        <>
            <button
                ref={button}
                type="button"
                className="dim-btn sm ghost icon tl-menu"
                aria-haspopup="menu"
                aria-expanded={!!at}
                title="Rename, duplicate or delete this stream"
                data-testid={testId}
                onClick={() => {
                    if (at) {
                        setAt(null)
                        return
                    }
                    const box = button.current!.getBoundingClientRect()
                    setAt({ left: box.left, bottom: innerHeight - box.top + 4 })
                }}
            >
                <Icon name="more-horizontal" size={14} />
            </button>
            {at && createPortal(
                <div
                    className="menu dim-card row-menu"
                    role="menu"
                    style={{ position: "fixed", left: at.left, bottom: at.bottom, top: "auto", zIndex: 60 }}
                >
                    {items.map((item, index) =>
                        "separator" in item
                            ? <div key={index} className="menu-sep" />
                            : "heading" in item
                            ? <div key={index} className="menu-heading">{item.heading}</div>
                            : (
                                <button
                                    key={index}
                                    type="button"
                                    role="menuitem"
                                    className={`menu-item ${item.danger ? "danger" : ""}`}
                                    disabled={item.disabled}
                                    title={item.hint}
                                    onClick={() => {
                                        setAt(null)
                                        item.onSelect()
                                    }}
                                >
                                    <span>{item.label}</span>
                                    {item.hint && <span className="menu-hint">{item.hint}</span>}
                                </button>
                            )
                    )}
                </div>,
                document.body,
            )}
        </>
    )
}

// Small shared pieces: toasts, the confirm / rename dialogs, a hover dropdown, the preview thumbnail.
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { api, type Thumb } from "./api.ts"

// ── toasts ──
type Toast = {
    id: number
    text: string
    kind: "ok" | "warn" | "danger" | "info"
}
let pushToast: (toast: Omit<Toast, "id">) => void = () => {}
export function toast(text: string, kind: Toast["kind"] = "info") {
    pushToast({ text, kind })
}
export function Toasts() {
    const [toasts, setToasts] = useState<Toast[]>([])
    useEffect(() => {
        let next = 1
        pushToast = (item) => {
            const id = next++
            setToasts((current) => [...current, { ...item, id }])
            setTimeout(
                () => setToasts((current) => current.filter((t) => t.id !== id)),
                item.kind === "danger" ? 7000 : 3500,
            )
        }
    }, [])
    return (
        <div className="dim-toasts" role="status">
            {toasts.map((t) => <div key={t.id} className={`dim-toast ${t.kind}`}>{t.text}</div>)}
        </div>
    )
}

// ── dialogs ──
export function Dialog(
    { title, children, onClose }: {
        title: string
        children: ReactNode
        onClose: () => void
    },
) {
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose()
        addEventListener("keydown", onKey)
        return () => removeEventListener("keydown", onKey)
    }, [onClose])
    return (
        <div
            className="scrim"
            onMouseDown={(event) => event.target === event.currentTarget && onClose()}
        >
            <div className="dialog dim-card" role="dialog" aria-label={title}>
                <p className="section-head">{title}</p>
                {children}
            </div>
        </div>
    )
}

export function ConfirmDialog(
    { title, body, action, danger, onConfirm, onClose }: {
        title: string
        body: ReactNode
        action: string
        danger?: boolean
        onConfirm: () => void
        onClose: () => void
    },
) {
    return (
        <Dialog title={title} onClose={onClose}>
            <div className="dialog-body">{body}</div>
            <div className="dialog-actions">
                <button type="button" className="dim-btn ghost" onClick={onClose}>
                    Cancel
                </button>
                <button
                    type="button"
                    autoFocus
                    className={`dim-btn ${danger ? "danger" : "primary"}`}
                    onClick={() => {
                        onConfirm()
                        onClose()
                    }}
                >
                    {action}
                </button>
            </div>
        </Dialog>
    )
}

export function RenameDialog(
    { name, onRename, onClose }: {
        name: string
        onRename: (name: string) => void
        onClose: () => void
    },
) {
    const extension = name.slice(name.lastIndexOf("."))
    const [value, setValue] = useState(name.slice(0, name.lastIndexOf(".")))
    const input = useRef<HTMLInputElement>(null)
    useEffect(() => input.current?.select(), [])
    const submit = () => {
        if (value.trim()) {
            onRename(value.trim() + extension)
            onClose()
        }
    }
    return (
        <Dialog title="Rename" onClose={onClose}>
            <div className="rename-field">
                <input
                    ref={input}
                    className="dim-input mono"
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    onKeyDown={(event) => event.key === "Enter" && submit()}
                    aria-label="new name"
                />
                <span className="mono muted">{extension}</span>
            </div>
            <div className="dialog-actions">
                <button type="button" className="dim-btn ghost" onClick={onClose}>
                    Cancel
                </button>
                <button type="button" className="dim-btn primary" onClick={submit}>
                    Rename
                </button>
            </div>
        </Dialog>
    )
}

// ── a dropdown that opens on hover (and on click, for touch) ──
export type MenuItem =
    | {
        label: string
        hint?: string
        disabled?: boolean
        danger?: boolean
        onSelect: () => void
    }
    | { separator: true }
    | { heading: string }

export function HoverMenu(
    { label, items, className = "", align = "right", testId }: {
        label: ReactNode
        items: MenuItem[]
        className?: string
        align?: "left" | "right"
        testId?: string
    },
) {
    const [open, setOpen] = useState(false)
    // opened by a click it stays open until a choice or a click elsewhere; opened by hover it follows the pointer
    const [pinned, setPinned] = useState(false)
    const timer = useRef<number | undefined>(undefined)
    const wrap = useRef<HTMLDivElement>(null)
    const close = () => {
        setOpen(false)
        setPinned(false)
    }
    useEffect(() => {
        if (!pinned) {
            return
        }
        const outside = (event: MouseEvent) => !wrap.current?.contains(event.target as Node) && close()
        addEventListener("mousedown", outside)
        return () => removeEventListener("mousedown", outside)
    }, [pinned])
    const show = () => {
        clearTimeout(timer.current)
        setOpen(true)
    }
    const hide = () => {
        clearTimeout(timer.current)
        if (!pinned) {
            timer.current = setTimeout(() => setOpen(false), 350)
        }
    }
    return (
        <div
            ref={wrap}
            className={`menu-wrap ${open ? "open" : ""}`}
            onMouseEnter={show}
            onMouseLeave={hide}
            data-testid={testId}
        >
            <button
                type="button"
                className={`dim-btn sm ${className}`}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => {
                    if (pinned) {
                        close()
                    } else {
                        setOpen(true)
                        setPinned(true)
                    }
                }}
            >
                {label}
            </button>
            {open && (
                <div className={`menu dim-card ${align}`} role="menu">
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
                                        close()
                                        item.onSelect()
                                    }}
                                >
                                    <span>{item.label}</span>
                                    {item.hint && <span className="menu-hint">{item.hint}</span>}
                                </button>
                            )
                    )}
                </div>
            )}
        </div>
    )
}

// ── the preview: plays by itself while on screen; the pointer's x scrubs it ──
/** "12 m", "1.4 km" */
function metres(value: number) {
    return value >= 1000 ? `${(value / 1000).toFixed(1)} km` : `${value < 10 ? value.toFixed(1) : Math.round(value)} m`
}

/** A recording with no camera: its odometry path from above (start dot, end ring), in the theme's colors. */
export function PathThumbnail({ thumb }: { thumb: Extract<Thumb, { state: "path" }> }) {
    // the unit box drawn into a 16:9 frame with a margin; svg y runs down, the path's y runs up
    const [w, h, pad] = [160, 90, 9]
    const side = Math.min(w, h) - 2 * pad
    const [ox, oy] = [(w - side) / 2, (h - side) / 2]
    const at = ([x, y]: [number, number]) => [ox + x * side, oy + (1 - y) * side] as const
    const line = thumb.points.map((p, i) => `${i ? "L" : "M"}${at(p).map((v) => v.toFixed(1)).join(" ")}`).join("")
    const [sx, sy] = at(thumb.points[0])
    const [ex, ey] = at(thumb.points[thumb.points.length - 1])
    const extent = Math.max(thumb.width, thumb.height)
    return (
        <div
            className="thumb path-thumb"
            title={`${thumb.stream}: ${metres(thumb.length)} of path, ${metres(thumb.width)} × ${
                metres(thumb.height)
            } (no camera: the odometry from above)`}
        >
            <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet" aria-label="odometry path from above">
                <rect x={ox} y={oy} width={side} height={side} className="path-frame" />
                <path d={line} className="path-line" />
                <circle cx={sx} cy={sy} r="3.2" className="path-start" />
                <circle cx={ex} cy={ey} r="3.4" className="path-end" />
            </svg>
            <span className="path-scale mono">{metres(extent)}</span>
        </div>
    )
}

export function Thumbnail(
    { id, thumb, version, src }: { id: string; thumb: Thumb; version: number; src?: string },
) {
    const box = useRef<HTMLDivElement>(null)
    const [frame, setFrame] = useState(0)
    const [visible, setVisible] = useState(false)
    const [scrubbing, setScrubbing] = useState(false)
    const frames = thumb.state === "ready" ? thumb.frames : 0
    const url = src ?? api.thumbnailUrl(id, version)
    useEffect(() => {
        if (!box.current) {
            return
        }
        const observer = new IntersectionObserver(
            ([entry]) => setVisible(entry.isIntersecting),
            { threshold: 0.4 },
        )
        observer.observe(box.current)
        return () => observer.disconnect()
    }, [])
    useEffect(() => {
        if (!frames || !visible || scrubbing) {
            return
        }
        const timer = setInterval(
            () => setFrame((current) => (current + 1) % frames),
            420,
        )
        return () => clearInterval(timer)
    }, [frames, visible, scrubbing])
    if (thumb.state === "path") {
        return <PathThumbnail thumb={thumb} />
    }
    if (thumb.state !== "ready") {
        return (
            <div
                ref={box}
                className={`thumb placeholder ${thumb.state}`}
                title={thumb.state === "none" ? thumb.reason : "making a preview…"}
            >
                <svg viewBox="0 0 64 40" aria-hidden="true">
                    <rect
                        x="6"
                        y="5"
                        width="52"
                        height="30"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                    />
                    <circle
                        cx="22"
                        cy="20"
                        r="5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                    />
                    <circle
                        cx="42"
                        cy="20"
                        r="5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                    />
                </svg>
                <span>{thumb.state === "none" ? "no preview" : "preview…"}</span>
            </div>
        )
    }
    return (
        <div
            ref={box}
            className="thumb"
            data-frame={frame}
            style={{
                backgroundImage: `url(${url})`,
                backgroundSize: `${frames * 100}% auto`,
                backgroundPositionY: "center",
                backgroundPositionX: `${frames > 1 ? (frame / (frames - 1)) * 100 : 0}%`,
            }}
            title={`${thumb.stream} · start, middle, end`}
            onPointerMove={(event) => {
                const rect = event.currentTarget.getBoundingClientRect()
                setScrubbing(true)
                setFrame(
                    Math.min(
                        frames - 1,
                        Math.max(
                            0,
                            Math.floor(((event.clientX - rect.left) / rect.width) * frames),
                        ),
                    ),
                )
            }}
            onPointerLeave={() => setScrubbing(false)}
        >
            <span
                className="thumb-bar"
                style={{ width: `${((frame + 1) / frames) * 100}%` }}
            />
        </div>
    )
}

// ── a floating menu: a row's context menu (at the pointer) or a button's dropdown (under it) ──
export type FloatAt = { x: number; y: number } | { anchor: HTMLElement }

/** Closes on a choice, a press elsewhere, Escape, a resize, or a scroll that moves its anchor. */
export function FloatMenu({ at, items, onClose }: { at: FloatAt; items: MenuItem[]; onClose: () => void }) {
    const box = useRef<HTMLDivElement>(null)
    const [place, setPlace] = useState<{ left: number; top: number } | null>(null)
    useLayoutEffect(() => {
        const el = box.current
        if (!el) {
            return
        }
        const rect = "anchor" in at ? at.anchor.getBoundingClientRect() : null
        let left = rect ? rect.right - el.offsetWidth : (at as { x: number }).x
        let top = rect ? rect.bottom + 4 : (at as { y: number }).y
        left = Math.max(8, Math.min(left, innerWidth - el.offsetWidth - 8))
        if (top + el.offsetHeight > innerHeight - 8) {
            top = Math.max(8, (rect ? rect.top - 4 : top) - el.offsetHeight)
        }
        setPlace({ left, top })
    }, [at])
    useEffect(() => {
        const anchor = "anchor" in at ? at.anchor : null
        const anchorTop = anchor?.getBoundingClientRect().top
        anchor?.setAttribute("aria-expanded", "true")
        const press = (event: PointerEvent) => {
            const target = event.target as Node
            if (!box.current?.contains(target) && !anchor?.contains(target)) {
                onClose()
            }
        }
        const key = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.stopPropagation()
                onClose()
            }
        }
        const scroll = (event: Event) => {
            if (box.current?.contains(event.target as Node)) {
                return
            }
            if (!anchor || Math.abs(anchor.getBoundingClientRect().top - (anchorTop ?? 0)) > 2) {
                onClose()
            }
        }
        addEventListener("pointerdown", press)
        addEventListener("keydown", key, true)
        addEventListener("scroll", scroll, true)
        addEventListener("resize", onClose)
        return () => {
            anchor?.setAttribute("aria-expanded", "false")
            removeEventListener("pointerdown", press)
            removeEventListener("keydown", key, true)
            removeEventListener("scroll", scroll, true)
            removeEventListener("resize", onClose)
        }
    }, [at, onClose])
    return createPortal(
        <div
            ref={box}
            className="float-menu menu dim-card"
            role="menu"
            style={place ?? { left: 0, top: 0, visibility: "hidden" }}
            onContextMenu={(event) => event.preventDefault()}
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
                            title={item.disabled ? item.hint : undefined}
                            onClick={() => {
                                onClose()
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
    )
}

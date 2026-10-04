// Small shared pieces: toasts, the confirm / rename dialogs, a hover dropdown, the preview thumbnail.
import { type ReactNode, useEffect, useRef, useState } from "react"
import { api, type Thumb } from "./api.ts"

// ── toasts ──
type Toast = { id: number; text: string; kind: "ok" | "warn" | "danger" | "info" }
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
export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose()
        addEventListener("keydown", onKey)
        return () => removeEventListener("keydown", onKey)
    }, [onClose])
    return (
        <div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
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
                <button type="button" className="dim-btn ghost" onClick={onClose}>Cancel</button>
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
    { name, onRename, onClose }: { name: string; onRename: (name: string) => void; onClose: () => void },
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
                <button type="button" className="dim-btn ghost" onClick={onClose}>Cancel</button>
                <button type="button" className="dim-btn primary" onClick={submit}>Rename</button>
            </div>
        </Dialog>
    )
}

// ── a dropdown that opens on hover (and on click, for touch) ──
export type MenuItem =
    | { label: string; hint?: string; disabled?: boolean; danger?: boolean; onSelect: () => void }
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
    const timer = useRef<number | undefined>(undefined)
    const show = () => {
        clearTimeout(timer.current)
        setOpen(true)
    }
    const hide = () => {
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setOpen(false), 180)
    }
    return (
        <div className={`menu-wrap ${open ? "open" : ""}`} onMouseEnter={show} onMouseLeave={hide} data-testid={testId}>
            <button
                type="button"
                className={`dim-btn sm ${className}`}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() =>
                    setOpen(!open)}
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
                                        setOpen(false)
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
export function Thumbnail({ id, thumb, version }: { id: string; thumb: Thumb; version: number }) {
    const box = useRef<HTMLDivElement>(null)
    const [frame, setFrame] = useState(0)
    const [visible, setVisible] = useState(false)
    const [scrubbing, setScrubbing] = useState(false)
    const frames = thumb.state === "ready" ? thumb.frames : 0
    useEffect(() => {
        if (!box.current) {
            return
        }
        const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: 0.4 })
        observer.observe(box.current)
        return () => observer.disconnect()
    }, [])
    useEffect(() => {
        if (!frames || !visible || scrubbing) {
            return
        }
        const timer = setInterval(() => setFrame((current) => (current + 1) % frames), 420)
        return () => clearInterval(timer)
    }, [frames, visible, scrubbing])
    if (thumb.state !== "ready") {
        return (
            <div
                ref={box}
                className={`thumb placeholder ${thumb.state}`}
                title={thumb.state === "none" ? thumb.reason : "making a preview…"}
            >
                <svg viewBox="0 0 64 40" aria-hidden="true">
                    <rect x="6" y="5" width="52" height="30" fill="none" stroke="currentColor" strokeWidth="2" />
                    <circle cx="22" cy="20" r="5" fill="none" stroke="currentColor" strokeWidth="2" />
                    <circle cx="42" cy="20" r="5" fill="none" stroke="currentColor" strokeWidth="2" />
                </svg>
                <span>{thumb.state === "none" ? "no camera" : "preview…"}</span>
            </div>
        )
    }
    return (
        <div
            ref={box}
            className="thumb"
            data-frame={frame}
            style={{
                backgroundImage: `url(${api.thumbnailUrl(id, version)})`,
                backgroundSize: `${frames * 100}% auto`,
                backgroundPositionY: "center",
                backgroundPositionX: `${frames > 1 ? (frame / (frames - 1)) * 100 : 0}%`,
            }}
            title={`${thumb.stream} · start, middle, end`}
            onPointerMove={(event) => {
                const rect = event.currentTarget.getBoundingClientRect()
                setScrubbing(true)
                setFrame(
                    Math.min(frames - 1, Math.max(0, Math.floor(((event.clientX - rect.left) / rect.width) * frames))),
                )
            }}
            onPointerLeave={() => setScrubbing(false)}
        >
            <span className="thumb-bar" style={{ width: `${((frame + 1) / frames) * 100}%` }} />
        </div>
    )
}

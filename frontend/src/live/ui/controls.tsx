// Small form controls every panel and layer settings editor shares.
import type { ReactNode } from "react"

export function Field(
    { label, children, hint }: {
        label: string
        children: ReactNode
        hint?: string
    },
) {
    return (
        <label className="field" title={hint}>
            <span className="field-label">{label}</span>
            <span className="field-control">{children}</span>
        </label>
    )
}

export function Select(
    { value, options, onChange }: {
        value: string
        options: [string, string][]
        onChange: (value: string) => void
    },
) {
    return (
        <select
            className="dim-select"
            value={value}
            onChange={(event) => onChange(event.target.value)}
        >
            {options.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
    )
}

export function Slider(
    { value, min, max, step, onChange, format }: {
        value: number
        min: number
        max: number
        step: number
        onChange: (value: number) => void
        format?: (value: number) => string
    },
) {
    return (
        <span className="slider">
            <input
                type="range"
                className="dim-range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(event) => onChange(Number(event.target.value))}
            />
            <span className="slider-value">{format ? format(value) : value}</span>
        </span>
    )
}

export function Toggle(
    { value, onChange, label }: {
        value: boolean
        onChange: (value: boolean) => void
        label?: string
    },
) {
    return (
        <label className="dim-switch toggle">
            <input
                type="checkbox"
                checked={value}
                onChange={(event) => onChange(event.target.checked)}
            />
            <span className="track" />
            {label && <span className="toggle-label">{label}</span>}
        </label>
    )
}

export function NumberInput(
    { value, onChange, step = 0.1, placeholder }: {
        value: number | null
        onChange: (value: number | null) => void
        step?: number
        placeholder?: string
    },
) {
    return (
        <input
            type="number"
            className="dim-input number"
            step={step}
            placeholder={placeholder}
            value={value ?? ""}
            onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}
        />
    )
}

export function IconButton(
    { title, onClick, active, children, className = "" }: {
        title: string
        onClick: () => void
        active?: boolean
        children: ReactNode
        className?: string
    },
) {
    return (
        <button
            type="button"
            className={`dim-btn icon icon-button ${active ? "on" : ""} ${className}`}
            title={title}
            aria-label={title}
            onClick={onClick}
        >
            {children}
        </button>
    )
}

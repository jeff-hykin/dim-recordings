// Stroke icons (24-unit grid, currentColor), from the shared dimOS set (src/dim-icons.js).
import { DIM_ICON_PATHS } from "../dim-icons.js"

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d={DIM_ICON_PATHS[name] ?? ""} />
        </svg>
    )
}

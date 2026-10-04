// The point-style picker: a card per style with a one-line description. Settings → Rendering uses it for the global
// default; each point-cloud layer uses it with a "default" card to follow that.
import { POINT_STYLES, type PointStyle } from "../core/render/pointMaterial.ts"

export function StylePicker(
    { value, onChange, withDefault }: {
        value: PointStyle | "default"
        onChange: (style: PointStyle | "default") => void
        withDefault?: string
    },
) {
    const options: [PointStyle | "default", string, string][] = [
        ...(withDefault
            ? [
                [
                    "default",
                    `default · ${withDefault}`,
                    "follow Settings → Rendering",
                ] as [PointStyle | "default", string, string],
            ]
            : []),
        ...(Object.keys(POINT_STYLES) as PointStyle[]).map((style) =>
            [style, POINT_STYLES[style].label, POINT_STYLES[style].about] as [
                PointStyle,
                string,
                string,
            ]
        ),
    ]
    return (
        <span className="style-picker" role="radiogroup">
            {options.map(([style, label, about]) => (
                <button
                    type="button"
                    role="radio"
                    aria-checked={value === style}
                    key={style}
                    className={`dim-panel style-card ${value === style ? "on" : ""}`}
                    onClick={() => onChange(style)}
                    title={about}
                >
                    <span
                        className={`style-swatch swatch-${style}`}
                        data-canvas-preview
                    />
                    <span className="style-name">{label}</span>
                    <span className="style-about">{about}</span>
                </button>
            ))}
        </span>
    )
}

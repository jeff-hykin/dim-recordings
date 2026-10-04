// View settings and the robot profile.
import { cameraAction, type ViewerApp } from "../core/app.ts"
import { saveSetting, useStore } from "../core/store.ts"
import { profiles } from "../profile/index.ts"
import { Field, Toggle } from "./controls.tsx"
import { Icon } from "./icons.tsx"
import { rendering } from "../core/render/rendering.ts"
import { StylePicker } from "./StylePicker.tsx"
import { CUBE_SHADES, type CubeShade, type PointStyle } from "../core/render/pointMaterial.ts"

export function SettingsPanel({ app }: { app: ViewerApp }) {
    const view = useStore(app.settings)
    const render = useStore(rendering)
    return (
        <div className="settings-panel">
            <Field
                label="Robot"
                hint="key bindings, drive topics, speeds and extra controls (src/profile)"
            >
                <select
                    className="dim-select"
                    value={app.profile.name}
                    onChange={(event) => {
                        // the page restarts on the new profile (every open viewer does, app.ts)
                        saveSetting("lv.view", { profile: event.target.value }).then(() => location.reload())
                    }}
                >
                    {profiles.map((profile) => (
                        <option key={profile.name} value={profile.name}>
                            {profile.name}
                        </option>
                    ))}
                </select>
            </Field>
            <h3 className="dim-label">Rendering</h3>
            <div className="field-block">
                <span className="field-label">Point style</span>
                <StylePicker
                    value={render.pointStyle}
                    onChange={(pointStyle) => rendering.update({ pointStyle: pointStyle as PointStyle })}
                />
                <p className="hint">
                    The default for every point cloud; a layer can pick its own in its settings.
                </p>
            </div>
            <Field label="Cube shading" hint={CUBE_SHADES[render.cubeShade]?.about}>
                <span className="dim-tabs segmented" data-cube-shade>
                    {(Object.keys(CUBE_SHADES) as CubeShade[]).map((shade) => (
                        <button
                            type="button"
                            key={shade}
                            className={`dim-tab ${render.cubeShade === shade ? "on" : ""}`}
                            aria-selected={render.cubeShade === shade}
                            onClick={() => rendering.update({ cubeShade: shade })}
                        >
                            {CUBE_SHADES[shade].label}
                        </button>
                    ))}
                </span>
            </Field>
            <Field label="Follow robot">
                <Toggle
                    value={view.follow}
                    onChange={(follow) => app.settings.update({ follow })}
                />
            </Field>
            <Field label="Stats">
                <Toggle
                    value={view.showStats}
                    onChange={(showStats) => app.settings.update({ showStats })}
                />
            </Field>
            <div className="button-row">
                <button
                    type="button"
                    className="dim-btn sm icon"
                    onClick={() => cameraAction("recenter")}
                >
                    <Icon name="target" size={16} /> Recenter
                </button>
                <button
                    type="button"
                    className="dim-btn sm icon"
                    onClick={() => cameraAction("topDown")}
                >
                    <Icon name="top" size={16} /> Top-down
                </button>
            </div>
            <p className="hint">
                Drag to orbit · right-drag or two fingers to pan · scroll or pinch to zoom.
            </p>
        </div>
    )
}

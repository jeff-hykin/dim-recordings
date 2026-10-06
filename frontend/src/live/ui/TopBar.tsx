// The Controller's top bar, for a recording: back to the list, the recording's name, render numbers, and the panel
// tabs (no connection pill, no drive state: nothing here is live).
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import { splatFallback } from "../core/render/rendering.ts"
import { Icon } from "./icons.tsx"
import type { Tab } from "./SidePanel.tsx"

const TABS: { tab: Tab; icon: string; label: string }[] = [
    { tab: "layers", icon: "layers", label: "Layers" },
    { tab: "tf", icon: "tree", label: "TF" },
    { tab: "settings", icon: "settings", label: "Settings" },
]

export function TopBar(
    { app, tab, onTab, name, detail, onBack }: {
        app: ViewerApp
        tab: Tab | null
        onTab: (tab: Tab) => void
        name: string
        detail: string
        onBack: () => void
    },
) {
    const stats = useStore(app.viewer.stats)
    const tf = useStore(app.tf.summary)
    const fallback = useStore(splatFallback)
    return (
        <header className="topbar">
            <button
                type="button"
                className="dim-btn ghost sm back"
                onClick={onBack}
                title="Back to the recordings"
                aria-label="Back to the recordings"
            >
                <Icon name="arrow-left" size={16} />
            </button>
            <img className="brand" src="./icon.svg" alt="" />
            <span className="title dim-title">Replayer</span>
            <span className="dim-badge dim-mono recording-pill" title={detail}>
                {name}
            </span>
            <span
                className="dim-badge dim-mono stats-pill"
                title="frames per second the 3D view draws"
            >
                {stats.fps} fps
            </span>
            {fallback.active && (
                <button
                    type="button"
                    className="dim-badge warn warn-pill"
                    title={`splat frames took ${
                        fallback.frameMs.toFixed(0)
                    } ms (over 16 ms): drawing cubes instead. Click to try splats again.`}
                    onClick={() => splatFallback.set({ active: false, frameMs: 0 })}
                >
                    splats → cubes ({fallback.frameMs.toFixed(0)} ms)
                </button>
            )}
            <span className="spacer" />
            <nav className="dim-tabs tabs">
                {TABS.map((item) => (
                    <button
                        type="button"
                        key={item.tab}
                        className={`dim-tab tab ${tab === item.tab ? "active" : ""}`}
                        aria-selected={tab === item.tab}
                        title={item.label}
                        aria-label={item.label}
                        onClick={() => onTab(item.tab)}
                    >
                        <Icon name={item.icon} />
                        <span className="tab-label">{item.label}</span>
                        {item.tab === "tf" && tf.problems > 0 && (
                            <span className="dim-badge warn tab-badge">{tf.problems}</span>
                        )}
                    </button>
                ))}
                <button
                    type="button"
                    className="dim-tab tab fullscreen-tab"
                    title="Fullscreen"
                    aria-label="Fullscreen"
                    onClick={() =>
                        (document.fullscreenElement
                            ? document.exitFullscreen()
                            : document.documentElement.requestFullscreen()).catch(() => {})}
                >
                    <Icon name="fullscreen" />
                </button>
            </nav>
        </header>
    )
}

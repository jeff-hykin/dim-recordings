// The panel the top bar's tabs open: a side panel on a desktop, a bottom sheet on a phone. The Controller's Drive and
// Record tabs have no place in a replay; Layers, Transforms and Settings are the Controller's own.
import type { ViewerApp } from "../core/app.ts"
import { Icon } from "./icons.tsx"
import { LayersPanel } from "./LayersPanel.tsx"
import { TfPanel } from "./TfPanel.tsx"
import { SettingsPanel } from "./SettingsPanel.tsx"

export type Tab = "layers" | "tf" | "settings"

const TITLES: Record<Tab, string> = {
    layers: "Layers",
    tf: "Transforms",
    settings: "Settings",
}

export function SidePanel(
    { app, tab, onClose, mobile }: {
        app: ViewerApp
        tab: Tab
        onTab: (tab: Tab) => void
        onClose: () => void
        mobile: boolean
    },
) {
    return (
        <aside
            className={`dim-panel glass side-panel ${mobile ? "sheet" : ""}`}
            data-tab={tab}
        >
            <div className="panel-head">
                <h2 className="dim-card-title">{TITLES[tab]}</h2>
                <button
                    type="button"
                    className="dim-btn icon icon-button"
                    title="Close"
                    aria-label="Close"
                    onClick={onClose}
                >
                    <Icon name="close" />
                </button>
            </div>
            <div className="panel-body">
                {tab === "layers" && <LayersPanel app={app} />}
                {tab === "tf" && <TfPanel app={app} />}
                {tab === "settings" && <SettingsPanel app={app} />}
            </div>
        </aside>
    )
}

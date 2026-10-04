// Every drawable topic, grouped by layer type: a switch (on = subscribed), live info or the problem, and the
// layer's own settings behind a disclosure.
import { useState } from "react"
import type { ViewerApp } from "../core/app.ts"
import type { LayerEntry } from "../core/layers/manager.ts"
import { useStore } from "../core/store.ts"
import { Toggle } from "./controls.tsx"
import { Icon } from "./icons.tsx"

function LayerRow({ app, entry }: { app: ViewerApp; entry: LayerEntry }) {
    const [open, setOpen] = useState(false)
    const Settings = entry.type.Settings
    return (
        <div
            className={`layer-row ${entry.enabled ? "on" : ""} ${entry.status.problem ? "problem" : ""}`}
            data-key={entry.topic.key}
        >
            <div className="layer-line">
                <Toggle
                    value={entry.enabled}
                    onChange={(enabled) => app.layers.setEnabled(entry.topic.key, enabled)}
                />
                <button
                    type="button"
                    className="layer-name"
                    onClick={() => setOpen(!open)}
                    disabled={!Settings}
                    title={entry.topic.key}
                >
                    <span className="topic-name">{entry.topic.name}</span>
                    <span className="topic-type">{entry.topic.type.split(".")[1]}</span>
                    {Settings && (
                        <span className={`chevron ${open ? "open" : ""}`}>
                            <Icon name="chevron-right" size={14} />
                        </span>
                    )}
                </button>
            </div>
            {entry.enabled && (entry.status.problem || entry.status.info) && (
                <div
                    className={`layer-status ${entry.status.problem ? "problem" : ""}`}
                >
                    {entry.status.problem ?? entry.status.info}
                </div>
            )}
            {open && Settings && (
                <div className="layer-settings">
                    <Settings settings={entry.settings} topic={entry.topic} />
                </div>
            )}
        </div>
    )
}

export function LayersPanel({ app }: { app: ViewerApp }) {
    const { list } = useStore(app.layers.entries)
    const connection = useStore(app.connection.status)
    const groups = new Map<string, LayerEntry[]>()
    for (const entry of list) {
        groups.set(entry.type.label, [
            ...(groups.get(entry.type.label) ?? []),
            entry,
        ])
    }
    const drawn = new Set(list.map((entry) => entry.topic.key))
    const other = connection.topics.filter((topic) => !drawn.has(topic.key))
    return (
        <div className="layers">
            {!list.length && (
                <p className="empty">
                    Waiting for topics… start a blueprint (or a replay) and they appear here.
                </p>
            )}
            {[...groups].map(([label, entries]) => (
                <section key={label} className="layer-group">
                    <h3 className="dim-label">{label}</h3>
                    {entries.map((entry) => <LayerRow key={entry.topic.key} app={app} entry={entry} />)}
                </section>
            ))}
            {other.length > 0 && (
                <details className="layer-group other-topics">
                    <summary>{other.length} other topics (not drawn)</summary>
                    {other.map((topic) => (
                        <div key={topic.key} className="other-topic">
                            <span>{topic.name}</span>
                            <span className="topic-type">{topic.type}</span>
                        </div>
                    ))}
                </details>
            )}
        </div>
    )
}

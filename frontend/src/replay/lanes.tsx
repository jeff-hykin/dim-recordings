// The playback bar's lanes: a row per stream with a tick wherever it has messages (exact times when it's small, else
// the backend's per-slice counts for the window on show), a switch that draws or hides it, and a menu that renames,
// duplicates or deletes it in the file.
import { useEffect, useState } from "react"
import { Toggle, useConfirm, usePrompt, useToast } from "dimos-react"
import { dimosKey } from "dimos-react"
import { type Overview, replayApi, type Timeline } from "./api.ts"
import { useStore } from "dimos-react/three"
import type { StreamInfo } from "./source.ts"

const KIND_LABEL: Record<StreamInfo["kind"], string> = {
    image: "camera",
    cloud: "point cloud",
    tf: "tf",
    pose: "pose",
    info: "camera info",
    other: "",
}

const LOCKED =
    "this recording is a link to a file outside the recordings folder: duplicate the recording to edit a copy"
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export function useStreamLanes(
    { overview, expanded, layers, onEdited }: {
        overview: Overview
        expanded: boolean
        /** dimos-react's LayerManager: a lane's switch is its stream's layer */
        // deno-lint-ignore no-explicit-any
        layers: any
        /** a stream edit finished: the page reloads the recording */
        onEdited: (renamed?: { from: string; to: string }) => void
    },
) {
    const [view, setView] = useState({ from: overview.start, to: overview.end })
    const [rows, setRows] = useState<Timeline | null>(null)
    const [busy, setBusy] = useState<string | null>(null)
    const confirm = useConfirm()
    const prompt = usePrompt()
    const toast = useToast()
    const { list: entries } = useStore(layers.entries) as { list: { topic: { key: string }; enabled: boolean }[] }

    // per-stream ticks for the visible window (re-asked when zoomed)
    useEffect(() => {
        if (!expanded) {
            return
        }
        let gone = false
        const timer = setTimeout(() => {
            fetch(
                `api/replay/${encodeURIComponent(overview.id)}/timeline?bins=1500&from=${view.from}&to=${view.to}`,
            ).then((response) => response.json()).then((data) => !gone && setRows(data)).catch(() => {})
        }, 120)
        return () => {
            gone = true
            clearTimeout(timer)
        }
    }, [expanded, overview.id, view.from, view.to])

    const run = async (
        stream: string,
        label: string,
        action: () => Promise<{ seconds: number }>,
        renamed?: { from: string; to: string },
    ) => {
        setBusy(stream)
        try {
            const result = await action()
            toast.ok(`${label} (${result.seconds.toFixed(1)} s)`)
            onEdited(renamed)
        } catch (error) {
            toast.error(String((error as Error).message ?? error))
        } finally {
            setBusy(null)
        }
    }
    const note = overview.format === "mcap"
        ? "Edits the .mcap in place: it's rewritten beside itself and swapped in, no copy is left."
        : "Edits the .db in place."
    const askName = async (
        title: string,
        initial: string,
        confirmLabel: string,
    ) => {
        const taken = overview.streams.map((other) => other.name)
        const name = (await prompt({
            title,
            defaultValue: initial,
            confirmLabel,
            message: note,
        }))?.trim()
        if (!name) {
            return null
        }
        if (!VALID_NAME.test(name)) {
            toast.warn(
                "A stream name is letters, digits and _ only, not starting with a digit.",
            )
            return null
        }
        if (taken.includes(name)) {
            toast.warn(`The recording already has a stream named ${name}.`)
            return null
        }
        return name
    }

    const locked = !overview.editable
    const lanes = overview.streams.map((stream) => {
        const key = dimosKey(stream.name, stream.type)
        const row = rows?.streams.find((other) => other.name === stream.name)
        const hz = stream.count > 1 && stream.end !== null && stream.start !== null &&
                stream.end > stream.start
            ? `${((stream.count - 1) / (stream.end - stream.start)).toFixed(1)} Hz`
            : ""
        const entry = entries.find((other) => other.topic.key === key)
        const shown = !!entry?.enabled
        const disabled = locked || busy !== null
        return {
            id: stream.name,
            label: stream.name,
            title: `${stream.name} · ${stream.type} (${stream.encoding})${hz ? ` · ${hz}` : ""}`,
            meta: KIND_LABEL[stream.kind] || stream.type,
            count: stream.count.toLocaleString(),
            active: shown,
            busy: busy === stream.name,
            ticks: row ? (row.times ? { times: row.times } : { counts: row.counts }) : null,
            leading: entry
                ? (
                    <Toggle
                        size="sm"
                        value={shown}
                        aria-label={shown ? `Hide ${stream.name}` : `Draw ${stream.name}`}
                        title={shown ? `Hide ${stream.name}` : `Draw ${stream.name}`}
                        onChange={(on: boolean) => layers.setEnabled(key, on)}
                    />
                )
                : undefined,
            menu: [
                { heading: stream.name },
                {
                    label: "Rename…",
                    disabled,
                    title: locked ? LOCKED : "in place, in the file",
                    onSelect: async () => {
                        const name = await askName(
                            `Rename ${stream.name}`,
                            stream.name,
                            "Rename",
                        )
                        if (name) {
                            run(
                                stream.name,
                                `Renamed ${stream.name} → ${name}`,
                                () => replayApi.renameStream(overview.id, stream.name, name),
                                { from: stream.name, to: name },
                            )
                        }
                    },
                },
                {
                    label: "Duplicate…",
                    disabled,
                    title: locked ? LOCKED : "a copy under a new name, in the file",
                    onSelect: async () => {
                        const name = await askName(
                            `Duplicate ${stream.name}`,
                            `${stream.name}_copy`,
                            "Duplicate",
                        )
                        if (name) {
                            run(
                                stream.name,
                                `Duplicated ${stream.name} → ${name}`,
                                () => replayApi.duplicateStream(overview.id, stream.name, name),
                            )
                        }
                    },
                },
                "-",
                {
                    label: "Delete…",
                    danger: true,
                    disabled,
                    title: locked ? LOCKED : "removes its messages from the file",
                    onSelect: async () => {
                        const sure = await confirm({
                            title: `Delete ${stream.name}?`,
                            message:
                                `Its ${stream.count.toLocaleString()} messages are removed from ${overview.name}. This can't be undone.`,
                            danger: true,
                            confirmLabel: "Delete stream",
                        })
                        if (sure) {
                            run(
                                stream.name,
                                `Deleted ${stream.name}`,
                                () => replayApi.deleteStream(overview.id, stream.name),
                            )
                        }
                    },
                },
            ],
        }
    })
    return { lanes, view, setView, dialogs: null }
}

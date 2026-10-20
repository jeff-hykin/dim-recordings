// Settings (the gear at the bottom left of the list): the extra folders to scan besides Desktop's recordings folder.
// The list lives in this page's localStorage only (extra_dirs.ts); the backend scans what the page sends it and says
// what it found in each, or why it couldn't read it.
import { useState } from "react"
import { Button, IconButton, ListRow, Modal, Spinner, Text, TextInput } from "dimos-react"
import type { ExtraDir } from "../api.ts"

export function SettingsModal(
    {
        open,
        onClose,
        sharedDir,
        sharedCount,
        dirs,
        setDirs,
        statuses,
        loaded,
        unreadIn,
    }: {
        open: boolean
        onClose: () => void
        sharedDir: string | undefined
        sharedCount: number
        dirs: string[]
        setDirs: (dirs: string[]) => void
        statuses: ExtraDir[] | undefined
        /** false until the first list arrives */
        loaded: boolean
        /** how many of a folder's recordings (undefined for the shared one) haven't been read yet */
        unreadIn: (dir: string | undefined) => number
    },
) {
    const [draft, setDraft] = useState("")
    const [problem, setProblem] = useState<string | null>(null)
    const add = () => {
        const dir = draft.trim().replace(/(.)\/+$/, "$1")
        if (!dir) {
            return
        }
        if (!dir.startsWith("/") && !dir.startsWith("~")) {
            setProblem("Give the full path (it starts with / or ~)")
            return
        }
        if (dirs.includes(dir)) {
            setProblem("That folder is already in the list")
            return
        }
        setDirs([...dirs, dir])
        setDraft("")
        setProblem(null)
    }
    const status = (dir: string) => {
        const found = statuses?.find((s) => s.dir === dir)
        if (!found) {
            return <Scanning />
        }
        if (found.error) {
            return (
                <Text small tone="warn" data-testid="extra-dir-error">
                    {found.error}
                </Text>
            )
        }
        return <Count count={found.count ?? 0} unread={unreadIn(dir)} />
    }
    return (
        <Modal
            open={open}
            size="md"
            title="Settings"
            onClose={onClose}
            footer={<Button onClick={onClose}>Done</Button>}
            data-testid="settings"
        >
            <Text as="p">
                Folders to scan for recordings, besides Desktop's recordings folder (each one sub-folder deep). This
                list is kept in this window's storage only.
            </Text>
            <div className="rec-settings-dirs">
                <ListRow
                    icon="folder"
                    title={<Text mono small title={sharedDir}>{sharedDir ?? "…"}</Text>}
                    subtitle={loaded
                        ? (
                            <Text small muted>
                                Desktop's recordings folder · <Count count={sharedCount} unread={unreadIn(undefined)} />
                            </Text>
                        )
                        : <Scanning />}
                />
                {dirs.map((dir) => (
                    <ListRow
                        key={dir}
                        icon="folder"
                        data-testid="extra-dir"
                        title={<Text mono small title={dir}>{dir}</Text>}
                        subtitle={status(dir)}
                        actions={
                            <IconButton
                                icon="close"
                                size="sm"
                                label={`Stop scanning ${dir}`}
                                onClick={() => setDirs(dirs.filter((other) => other !== dir))}
                            />
                        }
                    />
                ))}
            </div>
            <div className="rec-row-flex rec-settings-add">
                <TextInput
                    className="rec-grow"
                    mono
                    value={draft}
                    placeholder="~/Desktop/robot runs"
                    aria-label="folder to add"
                    invalid={!!problem}
                    onChange={(text) => {
                        setDraft(text)
                        setProblem(null)
                    }}
                    onEnter={add}
                />
                <Button icon="plus" disabled={!draft.trim()} onClick={add}>
                    Add folder
                </Button>
            </div>
            {problem && <Text small tone="warn">{problem}</Text>}
        </Modal>
    )
}

function Scanning() {
    return (
        <span className="rec-row-flex" data-testid="extra-dir-scanning">
            <Spinner size={12} label="scanning" />
            <Text small muted>scanning…</Text>
        </span>
    )
}

/** "12 recordings", or "12 recordings · reading 3…" while some aren't read yet */
function Count({ count, unread }: { count: number; unread: number }) {
    return (
        <Text small muted>
            {count} {count === 1 ? "recording" : "recordings"}
            {unread > 0 && ` · reading ${unread}…`}
        </Text>
    )
}

// The extra folders to scan besides Desktop's recordings folder: kept only in this page's localStorage (Settings
// edits them) and sent to the backend with each list (GET api/recordings?extraDirs=…) and at start (PUT api/extra-dirs).
import { useEffect, useState } from "react"

const KEY = "dim-recordings.extraDirs"

export function readExtraDirs(): string[] {
    try {
        const saved = JSON.parse(localStorage.getItem(KEY) ?? "[]")
        return Array.isArray(saved) ? saved.filter((dir) => typeof dir === "string") : []
    } catch {
        return [] // storage blocked or garbled: just the shared folder
    }
}

function writeExtraDirs(dirs: string[]) {
    try {
        localStorage.setItem(KEY, JSON.stringify(dirs))
    } catch {
        // storage blocked (a private window): the list lasts while this page does
    }
}

/** The list, kept in step with this app's other windows. */
export function useExtraDirs(): [string[], (dirs: string[]) => void] {
    const [dirs, setDirs] = useState(readExtraDirs)
    useEffect(() => {
        const update = (event: StorageEvent) => {
            if (event.key === KEY) {
                setDirs(readExtraDirs())
            }
        }
        addEventListener("storage", update)
        return () => removeEventListener("storage", update)
    }, [])
    const set = (next: string[]) => {
        writeExtraDirs(next)
        setDirs(next)
    }
    return [dirs, set]
}

/** "…/robot runs" → "robot runs" */
export const folderName = (dir: string) => dir.replace(/\/+$/, "").split("/").pop() || dir

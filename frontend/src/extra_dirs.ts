// The extra folders to scan besides Desktop's recordings folder: kept only in this page's localStorage (Settings
// edits them) and sent to the backend with each list (GET api/recordings?extraDirs=…) and at start (PUT api/extra-dirs).
import { useEffect, useState } from "react"

const KEY = "dim-recordings.extraDirs"

export function readExtraDirs(): string[] {
    try {
        const saved = JSON.parse(localStorage.getItem(KEY) ?? "[]")
        return Array.isArray(saved) ? cleanDirs(saved) : []
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

/** As the backend's cleanDirs (library.ts) keeps them, so the page can tell when a list answers the one it sent. */
export function cleanDirs(list: unknown[]): string[] {
    const dirs = list.filter((dir): dir is string => typeof dir === "string")
        .map((dir) => dir.trim().replace(/(.)\/+$/, "$1"))
    return [...new Set(dirs.filter(Boolean))].slice(0, 64)
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
        const clean = cleanDirs(next)
        writeExtraDirs(clean)
        setDirs(clean)
    }
    return [dirs, set]
}

/** "…/robot runs" → "robot runs" */
export const folderName = (dir: string) => dir.replace(/\/+$/, "").split("/").pop() || dir

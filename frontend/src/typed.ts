// Typed views of dimos-react's loosely typed (JS + generated .d.ts) hooks this app uses with its own state shapes.
import { usePersistentState as looseUsePersistentState } from "dimos-react"

export type Setter<T> = (next: T | ((old: T) => T)) => void

/** State kept in localStorage under `key` (dimos-react's usePersistentState). */
export const usePersistentState = looseUsePersistentState as <T>(
    key: string,
    initial: T,
) => [T, Setter<T>]

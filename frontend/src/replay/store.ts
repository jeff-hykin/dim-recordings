// A typed view of dimos-react's Store (a small observable value) for the playhead. Lives with the Replayer so three.js
// (dimos-react/three) loads only with it.
import { Store as LooseStore, useStore as looseUseStore } from "dimos-react/three"

export interface TypedStore<T> {
    get(): T
    set(value: T): void
    update(patch: Partial<T>): void
    subscribe(listener: () => void): () => void
}

/** A small observable value (dimos-react's Store). */
export const Store = LooseStore as unknown as new <T>(
    value: T,
) => TypedStore<T>
export const useStore = looseUseStore as <T>(store: TypedStore<T>) => T

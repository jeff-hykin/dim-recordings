// A tiny observable value: the core (no React) writes it, the UI reads it with useStore.
import { useSyncExternalStore } from "react"

export class Store<T extends object> {
    #value: T
    #listeners = new Set<() => void>()
    constructor(value: T) {
        this.#value = value
    }
    get(): T {
        return this.#value
    }
    set(value: T) {
        this.#value = value
        for (const listener of this.#listeners) {
            listener()
        }
    }
    update(patch: Partial<T>) {
        this.set({ ...this.#value, ...patch })
    }
    subscribe = (listener: () => void): () => void => {
        this.#listeners.add(listener)
        return () => this.#listeners.delete(listener)
    }
}

export function useStore<T extends object>(store: Store<T>): T {
    return useSyncExternalStore(store.subscribe, () => store.get())
}

// The Controller keeps these settings in its backend (api/settings); the Replayer keeps them per viewer in the
// browser (a remembered layer look or camera layout is a convenience, not shared state). Same API, so the copied
// layers and panels don't change.
const stores = new Map<string, Store<object>>()
const PREFIX = "dim-recordings.replay."

function load(key: string): object | null {
    try {
        const text = localStorage.getItem(PREFIX + key)
        return text ? JSON.parse(text) : null
    } catch {
        return null
    }
}

/** Kept for the copied code's sake: settings are local, so there is nothing to fetch. */
export function loadSettings(): Promise<void> {
    return Promise.resolve()
}

export function applyRemoteSetting(_key: string, _value: unknown) {}

export function saveSetting(key: string, value: object): Promise<void> {
    try {
        localStorage.setItem(PREFIX + key, JSON.stringify({ ...(load(key) ?? {}), ...value }))
    } catch {
        // no storage (private window): the page keeps its value
    }
    return Promise.resolve()
}

/** A store whose value is remembered in this browser under `key` (defaults filled in). */
export function persistentStore<T extends object>(
    key: string,
    defaults: T,
): Store<T> {
    const existing = stores.get(key)
    if (existing) {
        return existing as Store<T>
    }
    const store = new Store<T>({ ...defaults, ...(load(key) ?? {}) } as T)
    stores.set(key, store as Store<object>)
    let timer = 0
    store.subscribe(() => {
        clearTimeout(timer)
        timer = setTimeout(() => {
            try {
                localStorage.setItem(PREFIX + key, JSON.stringify(store.get()))
            } catch {
                // no storage: the page keeps its value
            }
        }, 150) as unknown as number
    })
    return store
}

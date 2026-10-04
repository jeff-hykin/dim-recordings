// One entry per discovered topic that some layer type draws; an enabled entry has a live instance (subscribed),
// a disabled one has none (unsubscribed, so it costs no bandwidth).
import { allLayerTypes, type LayerInstance, type LayerStatus, type LayerType } from "./registry.ts"
import { layerTypeFor } from "./registry.ts"
import { persistentStore, Store } from "../store.ts"
import type { Connection, Topic } from "../transport.ts"
import type { TfTree } from "../tf.ts"
import type { Viewer } from "../render/viewer.ts"
import type { VideoSources } from "../video.ts"
import type { RobotProfile } from "../../profile/types.ts"

export interface LayerEntry {
    topic: Topic
    type: LayerType<object>
    enabled: boolean
    status: LayerStatus
    settings: Store<object>
}

const ENABLED_KEY = "lv.layers.enabled"

export class LayerManager {
    readonly entries = new Store<{ list: LayerEntry[] }>({ list: [] })
    #instances = new Map<string, LayerInstance>()
    #enabled = persistentStore<Record<string, boolean>>(ENABLED_KEY, {})

    constructor(
        readonly viewer: Viewer,
        readonly tf: TfTree,
        readonly connection: Connection,
        readonly video: VideoSources,
        readonly profile: RobotProfile,
    ) {
        connection.status.subscribe(() => this.#sync(connection.status.get().topics))
        // turned on or off elsewhere (another viewer, the agent: PATCH api/settings lv.layers.enabled)
        this.#enabled.subscribe(() => {
            for (const entry of this.entries.get().list) {
                const wanted = this.#enabled.get()[entry.topic.key]
                if (wanted !== undefined && wanted !== entry.enabled) {
                    this.#apply(entry.topic.key, wanted)
                }
            }
        })
        connection.onSeek.add(() => {
            for (const instance of this.#instances.values()) {
                instance.reset?.()
            }
        })
        viewer.onFrame((frame) => {
            for (const instance of this.#instances.values()) {
                instance.update?.(frame)
            }
        })
    }

    #sync(topics: Topic[]) {
        const list = this.entries.get().list
        const known = new Set(list.map((entry) => entry.topic.key))
        const added: LayerEntry[] = []
        for (const topic of topics) {
            const type = layerTypeFor(topic.type)
            if (!type || known.has(topic.key)) {
                continue
            }
            const saved = this.#enabled.get()[topic.key]
            const enabled = saved ?? (type.enabledByDefault?.(topic) ?? true)
            const defaults = typeof type.defaults === "function" ? type.defaults(topic) : structuredClone(type.defaults)
            const settings = persistentStore(
                `lv.layer.${type.id}.${topic.key}`,
                defaults,
            )
            added.push({ topic, type, enabled, status: {}, settings })
        }
        if (!added.length) {
            return
        }
        const next = [...list, ...added].sort((a, b) => a.topic.name.localeCompare(b.topic.name))
        this.entries.set({ list: next })
        for (const entry of added) {
            if (entry.enabled) {
                this.#start(entry)
            }
        }
    }

    setEnabled(key: string, enabled: boolean) {
        this.#enabled.update({ [key]: enabled })
        this.#apply(key, enabled)
    }

    #apply(key: string, enabled: boolean) {
        const entry = this.entries.get().list.find((other) => other.topic.key === key)
        if (!entry || entry.enabled === enabled) {
            return
        }
        this.#patch(key, { enabled })
        if (enabled) {
            this.#start(entry)
        } else {
            this.#stop(key)
        }
    }

    /** Topics of one type that are being drawn (e.g. to pick a robot pose source). */
    enabledOfType(...types: string[]): Topic[] {
        return this.entries.get().list.filter((entry) => entry.enabled && types.includes(entry.topic.type)).map((
            entry,
        ) => entry.topic)
    }

    #patch(key: string, patch: Partial<LayerEntry>) {
        this.entries.set({
            list: this.entries.get().list.map((entry) => entry.topic.key === key ? { ...entry, ...patch } : entry),
        })
    }

    #start(entry: LayerEntry) {
        const key = entry.topic.key
        const context = {
            viewer: this.viewer,
            tf: this.tf,
            connection: this.connection,
            video: this.video,
            topics: () => this.connection.status.get().topics,
            profile: this.profile,
            setStatus: (status: LayerStatus) => {
                const current = this.entries.get().list.find((other) => other.topic.key === key)?.status
                if (
                    current?.info !== status.info || current?.problem !== status.problem
                ) {
                    this.#patch(key, { status: { ...current, ...status } })
                }
            },
        }
        try {
            const instance = entry.type.create(context, entry.topic, entry.settings)
            instance.root.matrixAutoUpdate = false
            this.viewer.scene.add(instance.root)
            this.#instances.set(key, instance)
        } catch (error) {
            this.#patch(key, { status: { problem: `failed to start: ${error}` } })
        }
        this.viewer.requestRender()
    }

    #stop(key: string) {
        const instance = this.#instances.get(key)
        if (!instance) {
            return
        }
        this.#instances.delete(key)
        this.viewer.scene.remove(instance.root)
        instance.dispose()
        this.#patch(key, { status: {} })
        this.viewer.requestRender()
    }
}

export { allLayerTypes }

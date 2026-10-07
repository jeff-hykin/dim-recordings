// Types for desktop_events.js
export type DesktopEvent = { type: string; [key: string]: unknown }
export function sseParser(onData: (data: string) => void): (chunk: string) => void
export function onDesktopEvent(
    type: string,
    callback: (event: DesktopEvent) => void,
    options?: { desktopUrl?: string },
): () => void
export function onDimosEvent(type: string, callback: (event: DesktopEvent) => void): () => void
export function onDesktopReconnect(callback: () => void): () => void

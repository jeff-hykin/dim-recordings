// What a view shows when WebGL (or anything else it draws with) fails: an in-place notice, and an error boundary that
// keeps one broken piece from blanking the app and starts over when its `resetKey` (the route, the recording) changes.
import { Component, type ReactNode } from "react"

/** The WebGL failure, said in place of the view that needed it. */
export function WebGLNotice({ what }: { what: string }) {
    return (
        <div className="webgl-notice dim-muted" role="status" data-testid="webgl-notice">
            {what} unavailable: this browser couldn't start WebGL
        </div>
    )
}

type Props = { resetKey: string; fallback: (error: Error) => ReactNode; children: ReactNode }

export class ViewBoundary extends Component<Props, { error: Error | null; key: string }> {
    state = { error: null as Error | null, key: this.props.resetKey }

    static getDerivedStateFromError(error: unknown) {
        return { error: error instanceof Error ? error : new Error(String(error)) }
    }

    // a new route / recording gets a fresh try
    static getDerivedStateFromProps(props: Props, state: { key: string }) {
        return props.resetKey === state.key ? null : { error: null, key: props.resetKey }
    }

    componentDidCatch(error: unknown) {
        console.error("view failed:", error)
    }

    render() {
        return this.state.error ? this.props.fallback(this.state.error) : this.props.children
    }
}

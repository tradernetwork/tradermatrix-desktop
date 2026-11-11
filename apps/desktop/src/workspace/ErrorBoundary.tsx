import { Component, type ErrorInfo, type ReactNode } from 'react'

export interface ErrorBoundaryProps {
  /** Shown in the message: which part of the app broke. */
  label: string
  children: ReactNode
  /** Extra recovery button (for example "Reset layout" on the chart panel). */
  action?: { label: string; run: () => void }
}

interface State {
  error: Error | null
  /** Bumped by Retry so the subtree is remounted from scratch. */
  attempt: number
}

/** Contains a render crash to its own panel (or to the shell): message, Retry, and an optional second action. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  state: State = { error: null, attempt: 0 }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[${this.props.label}] render failed`, error, info.componentStack)
  }

  render() {
    const { error, attempt } = this.state
    if (!error) return <div key={attempt} style={{ display: 'contents' }}>{this.props.children}</div>
    const { label, action } = this.props
    return (
      <div className="boundary" role="alert" data-testid="error-boundary">
        <b>{label} crashed</b>
        <pre>{error.message || String(error)}</pre>
        <div className="row">
          <button onClick={() => this.setState({ error: null, attempt: attempt + 1 })}>Retry</button>
          {action && (
            <button
              onClick={() => {
                action.run()
                this.setState({ error: null, attempt: attempt + 1 })
              }}
            >
              {action.label}
            </button>
          )}
        </div>
      </div>
    )
  }
}

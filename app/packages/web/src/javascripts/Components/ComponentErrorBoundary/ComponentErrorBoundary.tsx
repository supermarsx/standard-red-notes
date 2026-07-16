import { Component, ErrorInfo, ReactNode } from 'react'
import { addToast, ToastType } from '@standardnotes/toast'
import Button from '@/Components/Button/Button'
import { isDev } from '@/Utils'

type Props = {
  /** Human-readable name of the subtree being guarded (used in messages + logs). */
  regionName?: string
  /**
   * Back-compat alias for {@link Props.regionName}. Older callers pass `label`;
   * `regionName` takes precedence when both are supplied.
   */
  label?: string
  /** Optional custom fallback. Receives the error and a reset callback. */
  fallback?: (error: Error, reset: () => void) => ReactNode
  /** Called after the boundary resets (e.g. to re-trigger a dynamic import). */
  onReset?: () => void
  children: ReactNode
}

type State = {
  error?: Error
  /** Captured from `componentDidCatch` so the fallback can surface it. */
  componentStack?: string
}

/**
 * Detects errors thrown by webpack's dynamic `import()` when a code-split chunk
 * fails to load. This commonly happens after a deploy when the client is holding
 * a stale chunk manifest — a fresh page load fixes it. We match either the
 * conventional `ChunkLoadError` name or webpack's generated message.
 */
function isChunkLoadError(error: Error): boolean {
  return error.name === 'ChunkLoadError' || /Loading chunk [\w-]+ failed/i.test(error.message)
}

/**
 * Reusable error boundary that keeps a failed subtree from crashing the whole
 * app. Renders a friendly, self-contained fallback with a "Try again" button
 * (resets boundary state so the subtree — and any lazy import — is re-attempted),
 * surfaces a one-time toast, logs the error + component stack, and special-cases
 * chunk-load failures with a "Reload" affordance.
 *
 * The default fallback also includes a collapsible "Details" section exposing the
 * error message, stack, and React component stack. It is expanded in development
 * (`isDev`) and collapsed-but-present in production so support/power users can
 * still inspect a failure — the boundary NEVER renders a blank screen.
 */
export class ComponentErrorBoundary extends Component<Props, State> {
  private toastShownForError = false

  constructor(props: Props) {
    super(props)
    this.state = {}
  }

  private get regionLabel(): string {
    return this.props.regionName ?? this.props.label ?? 'this part of the app'
  }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    const context = this.regionLabel

    // Keep the component stack around so the fallback can display it; React only
    // provides it here (not in getDerivedStateFromError).
    this.setState({ error, componentStack: errorInfo.componentStack ?? undefined })
    console.error(`[ComponentErrorBoundary] Error rendering ${context}:`, error, errorInfo.componentStack)

    if (!this.toastShownForError) {
      this.toastShownForError = true
      addToast({
        type: ToastType.Error,
        message: `${context} failed to load. You can keep using the rest of the app.`,
      })
    }
  }

  reset = () => {
    this.toastShownForError = false
    this.setState({ error: undefined, componentStack: undefined })
    this.props.onReset?.()
  }

  reload = () => {
    window.location.reload()
  }

  render() {
    const { error, componentStack } = this.state

    if (!error) {
      return this.props.children
    }

    if (this.props.fallback) {
      return this.props.fallback(error, this.reset)
    }

    const context = this.regionLabel
    const chunkError = isChunkLoadError(error)

    const details = [error.message, error.stack, componentStack].filter(Boolean).join('\n\n')

    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="text-foreground text-base font-bold">
          {chunkError ? `${context} couldn't load` : `Something went wrong in ${context}`}
        </div>
        <div className="text-passive-0 max-w-[40ch] text-sm">
          {chunkError
            ? "This part of the app couldn't load — it may have just been updated. Reload to get the latest."
            : 'Something went wrong, but the rest of the app is still usable. You can try again.'}
        </div>
        <div className="mt-1 flex items-center gap-2">
          {chunkError ? (
            <Button primary onClick={this.reload}>
              Reload
            </Button>
          ) : (
            <Button primary onClick={this.reset}>
              Try again
            </Button>
          )}
          {chunkError && <Button onClick={this.reset}>Try again</Button>}
        </div>
        <details open={isDev} className="mt-2 w-full max-w-[60ch] text-left">
          <summary className="text-passive-0 cursor-pointer text-sm select-none">Details</summary>
          <pre className="border-border bg-contrast text-passive-0 mt-2 max-h-64 w-full overflow-auto rounded border p-2 text-left font-mono text-xs break-words whitespace-pre-wrap">
            {details}
          </pre>
        </details>
      </div>
    )
  }
}

export default ComponentErrorBoundary

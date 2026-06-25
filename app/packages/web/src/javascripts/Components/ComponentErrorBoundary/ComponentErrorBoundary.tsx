import { Component, ErrorInfo, ReactNode } from 'react'
import { addToast, ToastType } from '@standardnotes/toast'
import Button from '@/Components/Button/Button'

type Props = {
  /** Human-readable name of the subtree being guarded (used in messages + logs). */
  label?: string
  /** Optional custom fallback. Receives the error and a reset callback. */
  fallback?: (error: Error, reset: () => void) => ReactNode
  /** Called after the boundary resets (e.g. to re-trigger a dynamic import). */
  onReset?: () => void
  children: ReactNode
}

type State = {
  error?: Error
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
 */
export class ComponentErrorBoundary extends Component<Props, State> {
  private toastShownForError = false

  constructor(props: Props) {
    super(props)
    this.state = {}
  }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    const context = this.props.label ?? 'a component'

    // eslint-disable-next-line no-console
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
    this.setState({ error: undefined })
    this.props.onReset?.()
  }

  reload = () => {
    window.location.reload()
  }

  render() {
    const { error } = this.state

    if (!error) {
      return this.props.children
    }

    if (this.props.fallback) {
      return this.props.fallback(error, this.reset)
    }

    const context = this.props.label ?? 'This part of the app'
    const chunkError = isChunkLoadError(error)

    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="text-base font-bold text-foreground">
          {chunkError ? `${context} couldn't load` : `${context} ran into a problem`}
        </div>
        <div className="max-w-[40ch] text-sm text-passive-0">
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
          {chunkError && (
            <Button onClick={this.reset}>Try again</Button>
          )}
        </div>
      </div>
    )
  }
}

export default ComponentErrorBoundary

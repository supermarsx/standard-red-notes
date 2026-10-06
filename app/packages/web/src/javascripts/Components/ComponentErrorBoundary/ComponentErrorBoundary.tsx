import { Component, ErrorInfo, ReactNode } from 'react'
import { addToast, ToastType } from '@standardnotes/toast'
import Button from '@/Components/Button/Button'
import { isDev } from '@/Utils'
import { isCachedLazyRejection } from './isCachedLazyRejection'
import { reloadPage } from './reloadPage'

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
  /**
   * Called after the boundary clears its error, before `children` re-render.
   * Use it for state the caller owns. It cannot re-trigger a dynamic `import()`
   * that already failed — see the class docstring for why nothing can.
   */
  onReset?: () => void
  children: ReactNode
}

type State = {
  error?: Error
  /** Captured from `componentDidCatch` so the fallback can surface it. */
  componentStack?: string
}

/**
 * Heuristic: does this error look like webpack's dynamic `import()` failing to
 * fetch a code-split chunk? Usually a stale chunk manifest after a deploy, which
 * a fresh page load fixes. We match either the conventional `ChunkLoadError`
 * name or webpack's generated message.
 *
 * It is only a heuristic, and it under-matches on purpose: a chunk can fail to
 * arrive without producing either marker (see {@link isCachedLazyRejection}).
 * Treat a miss as "unknown", never as "a reset will fix it".
 */
function isChunkLoadError(error: Error): boolean {
  return error.name === 'ChunkLoadError' || /Loading chunk [\w-]+ failed/i.test(error.message)
}

/**
 * Reusable error boundary that keeps a failed subtree from crashing the whole
 * app. Renders a friendly, self-contained fallback, surfaces a one-time toast,
 * logs the error + component stack, and NEVER renders a blank screen.
 *
 * ## What a reset can and cannot fix
 *
 * "Try again" clears the boundary's error and re-renders `children`. That
 * recovers a failure whose cause is re-evaluated on the next render. It does
 * **not** re-run a `React.lazy` factory, and no change to this boundary could
 * make it: React's `lazyInitializer` calls the factory only while the payload
 * status is Uninitialized, overwrites the stored factory with the pending
 * thenable on that very first call, and parks the payload at Rejected on
 * failure, from which every later render re-throws the stored error. The
 * factory is gone by then — unreachable even from the lazy object — so the
 * wrapper cannot be re-created with a fresh one either. Only a full page load
 * fetches that chunk again, and `lazyWithRetry` has already spent its one
 * in-flight retry before any of this reaches a boundary.
 *
 * ## So the fallback only offers remedies that can work
 *
 * - A reset that demonstrably changed nothing — React re-threw the identical
 *   error object — leaves **Reload** as the only button, and says so.
 * - A proven cached lazy rejection, or a chunk-load error, leads with
 *   **Reload**; "Try again" stays only as a demoted second chance, and removes
 *   itself the moment the rule above proves it futile.
 * - Anything else leads with **Try again**, with **Reload** as the escape hatch,
 *   so a user is never left holding a single button that cannot help.
 *
 * The default fallback also includes a collapsible "Details" section exposing the
 * error message, stack, and React component stack. It is expanded in development
 * (`isDev`) and collapsed-but-present in production so support/power users can
 * still inspect a failure.
 */
export class ComponentErrorBoundary extends Component<Props, State> {
  private toastShownForError = false

  /**
   * The error that was on screen when the boundary was last reset. React
   * re-throws a cached lazy rejection **by object identity**, so the very same
   * object coming straight back is proof that the reset changed nothing.
   */
  private errorBeforeLastReset?: Error

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

  componentDidUpdate() {
    // Children have committed without throwing, so the reset we were judging
    // succeeded. Forget the error it was testing: a component that throws a
    // reused error object must not be condemned later by a reset that worked.
    if (this.state.error === undefined) {
      this.errorBeforeLastReset = undefined
    }
  }

  reset = () => {
    this.errorBeforeLastReset = this.state.error
    this.toastShownForError = false
    this.setState({ error: undefined, componentStack: undefined })
    this.props.onReset?.()
  }

  reload = () => {
    reloadPage()
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

    // A failure the subtree cannot re-attempt on its own: either proven (the
    // error IS a rejected lazy payload's cached value) or strongly indicated
    // (webpack reports the chunk never arrived).
    const loadFailure = isChunkLoadError(error) || isCachedLazyRejection(this.props.children, error)

    // Proof after the fact, for whatever the two checks above cannot see: the
    // user pressed "Try again" and React handed back the identical error.
    const resetProvenFutile = error === this.errorBeforeLastReset

    const details = [error.message, error.stack, componentStack].filter(Boolean).join('\n\n')

    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="text-foreground text-base font-bold">
          {loadFailure ? `${context} couldn't load` : `Something went wrong in ${context}`}
        </div>
        <div className="text-passive-0 max-w-[40ch] text-sm">
          {resetProvenFutile
            ? "Trying again didn't help — the same error came back. Reloading the page is the only thing that can fix this."
            : loadFailure
              ? "This part of the app couldn't load — it may have just been updated. Reload to get the latest."
              : 'Something went wrong, but the rest of the app is still usable. You can try again, or reload the page.'}
        </div>
        <div className="mt-1 flex items-center gap-2">
          {loadFailure || resetProvenFutile ? (
            <>
              <Button primary onClick={this.reload}>
                Reload
              </Button>
              {/*
                A demoted second chance, not the recommended remedy. It is here
                because `loadFailure` is only sometimes a proof: when it came
                from `isChunkLoadError` alone, the failure need not be a cached
                lazy payload at all and a reset may genuinely recover it. The
                moment a reset is shown not to (identical error back), this
                disappears — so a button that cannot work is offered at most
                once, and never silently.

                `lazyWithRetry.spec.tsx` (g) also pins its presence on the
                chunk path; dropping it outright for the structurally-proven
                case would need that test updated by its owner.
              */}
              {!resetProvenFutile && <Button onClick={this.reset}>Try again</Button>}
            </>
          ) : (
            <>
              <Button primary onClick={this.reset}>
                Try again
              </Button>
              <Button onClick={this.reload}>Reload</Button>
            </>
          )}
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

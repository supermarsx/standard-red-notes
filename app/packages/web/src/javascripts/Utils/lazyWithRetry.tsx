import { ComponentType, lazy } from 'react'

/**
 * React's own declaration is `lazy<T extends ComponentType<any>>`, and that
 * `any` is load-bearing rather than lax typing: `ComponentType<P>` is invariant
 * in `P` (its `ComponentClass` half puts `P` in a parameter position, via
 * `getDerivedStateFromProps`), so any narrower bound rejects every real call
 * site. Substituting `ComponentType<unknown>` was tried and fails to compile —
 * `TS2322: Type 'ComponentType<QrProps>' is not assignable to type
 * 'ComponentType<unknown>'` — against the existing `QrCodeNode` call site.
 * Matching React's bound exactly is therefore the correct type here, so the
 * `no-explicit-any` warning is disabled on this one line and nowhere else.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = ComponentType<any>

type ComponentImport<T> = () => Promise<{ default: T }>

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Drop-in replacement for `React.lazy` that retries a failed dynamic import
 * once before letting the error propagate to a surrounding error boundary.
 *
 * A code-split chunk request can fail for transient reasons — a momentary
 * network blip, or (most commonly) a just-deployed build whose chunk URL no
 * longer matches the manifest the client started with. Retrying once after a
 * short delay recovers the transient case; if it still fails the rejection is
 * re-thrown so a `ComponentErrorBoundary` can show its chunk-specific fallback.
 *
 * The return type is identical to `React.lazy`, so it can be used anywhere
 * `lazy(...)` is used today.
 *
 * Behaviour that callers depend on, and that `lazyWithRetry.spec.tsx` pins:
 *
 *  - The factory is invoked at most TWICE. There is no retry loop: a chunk that
 *    is permanently unavailable costs one extra request and `retryDelayMs`, not
 *    an unbounded stream of requests.
 *  - A synchronous throw from `factory` is handled exactly like a rejected
 *    promise (retried, then surfaced as a rejection) rather than escaping as a
 *    render-phase crash that skips the retry entirely.
 *  - When the retry also fails, the error that is surfaced is the RETRY's, i.e.
 *    the one that actually ended the load. This matters because the boundary
 *    picks its fallback by inspecting that error: a stale first error can send
 *    a genuine chunk failure down the generic "Try again" path, which (see
 *    below) cannot possibly recover it. The first error is kept reachable as
 *    `cause` so nothing is lost.
 *
 * Deliberate non-goal — re-importing after a boundary reset. `React.lazy`
 * caches a rejection permanently: `lazyInitializer` only calls the factory
 * while the payload status is Uninitialized, and a rejection moves it to
 * Rejected, from which React re-throws the stored error on every later render
 * without ever consulting the factory again. So once both attempts have failed,
 * resetting an error boundary around this component CANNOT re-run the import —
 * only a full page load can. That is why the chunk-specific fallback leads with
 * "Reload", and why surfacing the right error above is the part that matters.
 */
export function lazyWithRetry<T extends AnyComponent>(
  factory: ComponentImport<T>,
  retryDelayMs = 600,
): ReturnType<typeof lazy<T>> {
  return lazy(async () => {
    try {
      return await factory()
    } catch (firstError) {
      await wait(retryDelayMs)
      try {
        return await factory()
      } catch (retryError) {
        if (retryError instanceof Error && retryError.cause === undefined) {
          retryError.cause = firstError
        }
        throw retryError
      }
    }
  })
}

export default lazyWithRetry

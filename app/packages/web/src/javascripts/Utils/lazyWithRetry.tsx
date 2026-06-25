import { ComponentType, lazy } from 'react'

type ComponentImport<T extends ComponentType<unknown>> = () => Promise<{ default: T }>

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
 */
export function lazyWithRetry<T extends ComponentType<any>>(
  factory: ComponentImport<T>,
  retryDelayMs = 600,
): ReturnType<typeof lazy<T>> {
  return lazy(() =>
    factory().catch((error) => {
      return new Promise<{ default: T }>((resolve, reject) => {
        setTimeout(() => {
          factory()
            .then(resolve)
            .catch(() => reject(error))
        }, retryDelayMs)
      })
    }),
  )
}

export default lazyWithRetry

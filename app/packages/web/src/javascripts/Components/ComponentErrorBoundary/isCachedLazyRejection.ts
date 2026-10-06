import { isValidElement, ReactNode } from 'react'

/**
 * React tags every value returned by `lazy()` with this symbol — it is the same
 * `REACT_LAZY_TYPE` React itself matches on, and `Symbol.for` keeps the check
 * working across duplicate React copies in a bundle.
 */
const REACT_LAZY_TYPE = Symbol.for('react.lazy')

/**
 * `Rejected` in React's lazy payload-status enum: Uninitialized = -1,
 * Pending = 0, Resolved = 1, Rejected = 2 (`react/cjs/react.production.js`,
 * `lazyInitializer`). A payload parked here re-throws `_result` on every render
 * and never consults its factory again — which the factory could not satisfy
 * anyway, because the Pending transition already overwrote it with the thenable.
 */
const LAZY_PAYLOAD_REJECTED = 2

/** The fallback must never become the expensive part of a crash. */
const MAX_DEPTH = 8
const MAX_ELEMENTS = 256

type LazyPayload = { _status?: unknown; _result?: unknown }

/** The payload of `type`, if `type` is the object `React.lazy()` returns. */
const lazyPayloadOf = (type: unknown): LazyPayload | undefined => {
  if (typeof type !== 'object' || type === null) {
    return undefined
  }

  const candidate = type as { $$typeof?: unknown; _payload?: unknown }
  if (candidate.$$typeof !== REACT_LAZY_TYPE) {
    return undefined
  }

  const payload = candidate._payload
  return typeof payload === 'object' && payload !== null ? (payload as LazyPayload) : undefined
}

/**
 * Is `error` the value a rejected `React.lazy` payload inside `children` is
 * re-throwing?
 *
 * This is a proof, not a heuristic: it matches the caught error against the
 * payload's stored `_result` **by object identity**, so it cannot mistake an
 * unrelated failure for a cached one, and it is blind to the error's name,
 * message and shape. That matters because those lie — nginx `try_files $uri
 * /index.html` answers a missing chunk with 200 text/html, so the chunk arrives
 * as a `SyntaxError` that no `ChunkLoadError` pattern will ever match, and a
 * chunk that loads but throws while evaluating produces whatever its module
 * threw.
 *
 * When it is true, resetting an error boundary around `children` cannot help:
 * React will re-throw the identical error on the next render without calling
 * the factory (see {@link LAZY_PAYLOAD_REJECTED}). Only a full page load will.
 *
 * It answers `false` when the lazy element is not statically reachable from
 * `children` (it is rendered by some intermediate component rather than passed
 * in). That is a safe direction to be wrong in: the caller still has its
 * chunk-error heuristic and its after-the-fact check for a reset that demonstrably
 * changed nothing.
 */
export function isCachedLazyRejection(children: ReactNode, error: unknown): boolean {
  let budget = MAX_ELEMENTS

  const visit = (node: ReactNode, depth: number): boolean => {
    if (budget <= 0 || depth > MAX_DEPTH) {
      return false
    }

    if (Array.isArray(node)) {
      return node.some((child) => visit(child as ReactNode, depth))
    }

    if (!isValidElement(node)) {
      return false
    }

    budget -= 1

    const payload = lazyPayloadOf(node.type)
    if (payload !== undefined && payload._status === LAZY_PAYLOAD_REJECTED && payload._result === error) {
      return true
    }

    const props = node.props as { children?: ReactNode } | null | undefined
    return visit(props?.children, depth + 1)
  }

  return visit(children, 0)
}

export default isCachedLazyRejection

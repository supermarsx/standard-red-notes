import React from 'react'
import ComponentErrorBoundary from '@/Components/ComponentErrorBoundary/ComponentErrorBoundary'

type Props = {
  /** Preferred label for the guarded region (forwarded to ComponentErrorBoundary). */
  regionName?: string
  /** Back-compat alias kept for existing callers; `regionName` takes precedence. */
  label?: string
  children: React.ReactNode
}

/**
 * Backwards-compatible alias for the reusable {@link ComponentErrorBoundary}.
 * Historically this rendered a plain "Something went wrong rendering this
 * component" message and could take down the surrounding subtree. It now
 * delegates to ComponentErrorBoundary so every existing usage gains the
 * graceful, retryable fallback (with chunk-load detection, a one-time toast,
 * and logging) for free.
 */
export const ErrorBoundary: React.FC<Props> = ({ regionName, label, children }) => (
  <ComponentErrorBoundary regionName={regionName} label={label}>
    {children}
  </ComponentErrorBoundary>
)

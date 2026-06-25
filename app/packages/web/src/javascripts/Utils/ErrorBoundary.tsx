import React from 'react'
import ComponentErrorBoundary from '@/Components/ComponentErrorBoundary/ComponentErrorBoundary'

type Props = {
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
export const ErrorBoundary: React.FC<Props> = ({ label, children }) => (
  <ComponentErrorBoundary label={label}>{children}</ComponentErrorBoundary>
)

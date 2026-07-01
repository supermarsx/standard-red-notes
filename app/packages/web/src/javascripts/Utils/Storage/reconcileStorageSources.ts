// Pure, dependency-free reconciliation math for the Storage pane's source
// breakdown. Kept separate from StorageUsageManager (which owns the worker plumbing)
// so the "does the breakdown add up to the total?" logic is unit-testable in
// isolation and reused by both the manager and any snapshot post-processing.
//
// The breakdown reconciles to the origin total (navigator.storage.estimate().usage)
// as:  sum(measured sources) + residual === total,  residual >= 0.
// The residual is everything the browser reports as used but the app cannot itemize
// (IndexedDB structural overhead, service-worker registration, Cache API quota
// padding for opaque responses, etc.). It is surfaced as a single "System / overhead"
// row rather than an opaque "Other / Unaccounted" bucket.

import { StorageSource, UNACCOUNTED_SOURCE_ID } from './storageUsageWorkerProtocol'

/** Display label for the reconciling residual row. */
export const OVERHEAD_SOURCE_LABEL = 'System / overhead'

/** Tooltip/explanation shown next to the residual row so it isn't opaque. */
export const OVERHEAD_SOURCE_DESCRIPTION =
  'IndexedDB overhead and browser-managed storage — service-worker registration and ' +
  'cache quota padding — that the browser does not let the app itemize.'

/**
 * Sum the on-disk bytes of the measured sources. Non-finite or negative byte counts
 * are ignored so a single bad measurement can't corrupt the total.
 */
export function sumSourceBytes(sources: readonly Pick<StorageSource, 'bytes'>[]): number {
  return sources.reduce((sum, source) => {
    return Number.isFinite(source.bytes) && source.bytes > 0 ? sum + source.bytes : sum
  }, 0)
}

/**
 * The residual that reconciles measured sources to the origin estimate:
 *   estimate - sum(measured), CLAMPED to >= 0.
 * Measured can exceed the estimate because the estimate is a coarse, rounded browser
 * figure — clamping prevents a negative "overhead" row. Returns 0 when there is no
 * usable estimate so callers render no residual row rather than a bogus one.
 */
export function computeResidualBytes(measuredBytes: number, estimatedUsage: number | undefined): number {
  if (typeof estimatedUsage !== 'number' || !Number.isFinite(estimatedUsage) || estimatedUsage <= 0) {
    return 0
  }
  const residual = estimatedUsage - measuredBytes
  return residual > 0 ? residual : 0
}

/**
 * Build the synthetic "System / overhead" residual source, or undefined when there
 * is nothing to reconcile (no estimate, or measured already meets/exceeds it). The
 * returned source, appended to `sources`, makes the breakdown sum to the estimate.
 */
export function buildResidualSource(
  sources: readonly Pick<StorageSource, 'bytes'>[],
  estimatedUsage: number | undefined,
): StorageSource | undefined {
  const bytes = computeResidualBytes(sumSourceBytes(sources), estimatedUsage)
  if (bytes <= 0) {
    return undefined
  }
  return {
    id: UNACCOUNTED_SOURCE_ID,
    label: OVERHEAD_SOURCE_LABEL,
    bytes,
    count: 0,
    description: OVERHEAD_SOURCE_DESCRIPTION,
  }
}

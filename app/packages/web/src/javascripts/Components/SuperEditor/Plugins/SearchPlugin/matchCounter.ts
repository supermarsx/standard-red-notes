/**
 * Pure helpers for the search "current / total" match counter.
 *
 * Kept free of any React/DOM dependencies so the display logic can be unit-tested in
 * isolation (see matchCounter.spec.ts) and reused by the search plugin UI.
 */

/**
 * Clamps the active result index into a valid range given the number of results.
 *
 * - When there are no results, returns -1 (nothing active).
 * - Otherwise the index is wrapped/clamped so it always points at a real result. This
 *   keeps Next/Previous cycling and the counter consistent even if the results list
 *   shrinks (e.g. after a replace or an edit) while an index is held.
 */
export function clampResultIndex(index: number, total: number): number {
  if (total <= 0) {
    return -1
  }
  if (index < 0) {
    return 0
  }
  if (index >= total) {
    return total - 1
  }
  return index
}

/**
 * Computes the next index when cycling forwards through results, wrapping to the start.
 */
export function nextResultIndex(currentIndex: number, total: number): number {
  if (total <= 0) {
    return -1
  }
  const next = currentIndex + 1
  return next >= total ? 0 : next
}

/**
 * Computes the previous index when cycling backwards through results, wrapping to the end.
 */
export function previousResultIndex(currentIndex: number, total: number): number {
  if (total <= 0) {
    return -1
  }
  const prev = currentIndex - 1
  return prev < 0 ? total - 1 : prev
}

export type MatchCounter = {
  /** 1-based position of the active result, or 0 when none is active. */
  current: number
  /** Total number of matches. */
  total: number
  /** Pre-formatted "current / total" (or just "0" / "total") label for display. */
  label: string
}

/**
 * Builds the data needed to render the match counter.
 *
 * Guarantees the displayed numbers are coherent:
 * - never shows a current position greater than the total,
 * - shows "0" (no "/") when there are matches but none is active yet, or no matches.
 */
export function getMatchCounter(activeIndex: number, total: number): MatchCounter {
  const safeTotal = total > 0 ? total : 0

  // A negative index means "no active result yet" — don't invent a position. Only an
  // index that overflows the (positive) total is clamped down to the last result.
  let current = 0
  if (safeTotal > 0 && activeIndex >= 0) {
    current = Math.min(activeIndex, safeTotal - 1) + 1
  }

  const label = current > 0 ? `${current} / ${safeTotal}` : `${safeTotal}`

  return { current, total: safeTotal, label }
}

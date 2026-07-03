/**
 * Standard Red Notes: pure, unit-tested helpers backing the Admin Users tab's
 * BULK actions (multi-select + bulk ban/unban/role/feature-flag over the
 * currently loaded page).
 *
 * Everything here is side-effect free so the tricky parts — selection-set
 * transitions, the bounded-concurrency runner and partial-failure
 * summarisation — stay deterministic and testable. The React component owns the
 * actual admin API calls and passes them in as the per-item worker.
 */

// ---------------------------------------------------------------------------
// Selection state transitions
// ---------------------------------------------------------------------------

/**
 * Selection model (documented behaviour):
 * - The selected set holds user uuids from the CURRENTLY loaded page only.
 * - The component clears the set on any list reload (page change, filter
 *   change, page-size change, manual Refresh, and the post-action refresh), so
 *   the set never carries stale uuids across pages. Selection is therefore
 *   predictable: what you see checked is exactly what a bulk action targets.
 */

/** Add the uuid if absent, remove it if present. Returns a NEW set. */
export const toggleSelected = (selected: ReadonlySet<string>, uuid: string): Set<string> => {
  const next = new Set(selected)
  if (next.has(uuid)) {
    next.delete(uuid)
  } else {
    next.add(uuid)
  }
  return next
}

/**
 * Select or deselect every uuid on the current page, preserving any other
 * (off-page) uuids that might still be in the set. Returns a NEW set.
 */
export const setPageSelection = (
  selected: ReadonlySet<string>,
  pageUuids: readonly string[],
  shouldSelect: boolean,
): Set<string> => {
  const next = new Set(selected)
  for (const uuid of pageUuids) {
    if (shouldSelect) {
      next.add(uuid)
    } else {
      next.delete(uuid)
    }
  }
  return next
}

export type PageSelectionState = 'none' | 'partial' | 'all'

/**
 * How the header "select all" checkbox should render for the current page:
 * 'none' (unchecked), 'all' (checked) or 'partial' (indeterminate). An empty
 * page is always 'none'.
 */
export const pageSelectionState = (selected: ReadonlySet<string>, pageUuids: readonly string[]): PageSelectionState => {
  if (pageUuids.length === 0) {
    return 'none'
  }
  let selectedCount = 0
  for (const uuid of pageUuids) {
    if (selected.has(uuid)) {
      selectedCount += 1
    }
  }
  if (selectedCount === 0) {
    return 'none'
  }
  return selectedCount === pageUuids.length ? 'all' : 'partial'
}

/**
 * The selected uuids that are actually present on the current page, IN PAGE
 * ORDER. Guards bulk actions against any off-page uuid lingering in the set.
 */
export const selectedUuidsOnPage = (selected: ReadonlySet<string>, pageUuids: readonly string[]): string[] =>
  pageUuids.filter((uuid) => selected.has(uuid))

/**
 * Split a target list into the uuids to act on and whether the acting admin's
 * OWN uuid was removed. Mirrors the single self-revoke guard: the admin must
 * not bulk-revoke their own admin role (or otherwise self-target) — the caller
 * surfaces `excludedSelf` as a note.
 */
export const excludeSelfTarget = (
  uuids: readonly string[],
  selfUuid: string | undefined | null,
): { targets: string[]; excludedSelf: boolean } => {
  if (!selfUuid) {
    return { targets: [...uuids], excludedSelf: false }
  }
  const targets = uuids.filter((uuid) => uuid !== selfUuid)
  return { targets, excludedSelf: targets.length !== uuids.length }
}

// ---------------------------------------------------------------------------
// Bounded-concurrency runner + partial-failure collection
// ---------------------------------------------------------------------------

export type BulkItemResult = {
  uuid: string
  ok: boolean
  /** Present only on failure. */
  error?: string
}

export type BulkRunSummary = {
  total: number
  succeeded: BulkItemResult[]
  failed: BulkItemResult[]
}

/** Best-effort human message from whatever a rejected worker threw. */
export const errorMessageOf = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === 'string') {
    return error
  }
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') {
      return message
    }
  }
  return 'Unknown error'
}

/**
 * Run `worker` over `items` with at most `concurrency` in flight at once (a
 * simple fixed-size worker pool, NOT all-at-once). A worker that rejects is
 * recorded as a per-item failure and NEVER aborts the batch; the run always
 * resolves once every item settles. `onProgress(completed, total)` fires after
 * each item settles, in completion order.
 *
 * Results are returned in the original `items` order.
 */
export const runBulkWithConcurrency = async <T>(
  items: readonly T[],
  getUuid: (item: T) => string,
  worker: (item: T) => Promise<void>,
  options: { concurrency?: number; onProgress?: (completed: number, total: number) => void } = {},
): Promise<BulkRunSummary> => {
  const total = items.length
  const results: BulkItemResult[] = new Array(total)
  // At least 1, never more than there are items, and default to 5.
  const requested = Math.floor(options.concurrency ?? 5)
  const concurrency = Math.max(1, Math.min(Number.isFinite(requested) ? requested : 5, total))

  let nextIndex = 0
  let completed = 0

  const runLane = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex
      nextIndex += 1
      if (index >= total) {
        return
      }
      const item = items[index]
      const uuid = getUuid(item)
      try {
        await worker(item)
        results[index] = { uuid, ok: true }
      } catch (error) {
        results[index] = { uuid, ok: false, error: errorMessageOf(error) }
      }
      completed += 1
      options.onProgress?.(completed, total)
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => runLane()))

  const succeeded: BulkItemResult[] = []
  const failed: BulkItemResult[] = []
  for (const result of results) {
    ;(result.ok ? succeeded : failed).push(result)
  }
  return { total, succeeded, failed }
}

// ---------------------------------------------------------------------------
// Result summarisation
// ---------------------------------------------------------------------------

const pluralizeUsers = (count: number): string => (count === 1 ? 'user' : 'users')

/**
 * One-line toast summary of a bulk run, e.g. "Banned 38 users" or
 * "Banned 36 users, 2 failed". `pastVerb` is a past-tense verb like "Banned".
 * `hasFailures` lets the caller pick the toast severity.
 */
export const summarizeBulkOutcome = (
  pastVerb: string,
  summary: BulkRunSummary,
): { message: string; hasFailures: boolean } => {
  const succeeded = summary.succeeded.length
  const failed = summary.failed.length
  const base = `${pastVerb} ${succeeded} ${pluralizeUsers(succeeded)}`
  if (failed === 0) {
    return { message: `${base}.`, hasFailures: false }
  }
  return { message: `${base}, ${failed} failed.`, hasFailures: true }
}

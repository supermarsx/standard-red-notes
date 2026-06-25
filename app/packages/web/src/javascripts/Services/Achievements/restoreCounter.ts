/**
 * Standard Red Notes: per-item restore counter.
 *
 * Tracks how many times each item (by uuid) has been restored from the trash,
 * persisted in localStorage as a `{ uuid: count }` map. Used to power the
 * "restore the SAME item N times" achievement. Fully guarded: SSR/private-mode
 * safe and never throws.
 */

const STORAGE_KEY = 'sn_item_restore_counts'

type RestoreCounts = Record<string, number>

function readCounts(): RestoreCounts {
  if (typeof localStorage === 'undefined') {
    return {}
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) {
      return {}
    }
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      return parsed as RestoreCounts
    }
    return {}
  } catch {
    return {}
  }
}

function writeCounts(counts: RestoreCounts): void {
  if (typeof localStorage === 'undefined') {
    return
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(counts))
  } catch {
    /* best-effort; ignore storage failures */
  }
}

/**
 * Increment the restore count for the given uuid and return the new count.
 * Returns 0 on any failure so callers can safely use the result.
 */
export function recordItemRestore(uuid: string): number {
  if (!uuid) {
    return 0
  }
  try {
    const counts = readCounts()
    const next = (typeof counts[uuid] === 'number' ? counts[uuid] : 0) + 1
    counts[uuid] = next
    writeCounts(counts)
    return next
  } catch {
    return 0
  }
}

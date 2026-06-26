// Pure, React-free helpers for the Storage pane: friendly content-type labels and
// the localStorage snapshot cache that lets the pane render the last result
// instantly on reopen while a fresh background scan runs.

import { StorageUsageSnapshot } from '@/Utils/Storage/storageUsageWorkerProtocol'

/** Map raw content_type strings to friendly display labels. Unknowns pass through. */
const CONTENT_TYPE_LABELS: Record<string, string> = {
  Note: 'Notes',
  Tag: 'Tags',
  'SN|File': 'Files',
  'SN|FileSafe|FileMetadata': 'File metadata',
  'SN|Component': 'Components',
  'SN|Theme': 'Themes',
  'SN|ItemsKey': 'Encryption keys',
  'SN|UserPreferences': 'Preferences',
  'SN|SmartTag': 'Smart views',
  SmartView: 'Smart views',
  'SN|Privileges': 'Privileges',
  'SN|ExtensionRepo': 'Plugin repos',
  Unknown: 'Other',
}

export function contentTypeLabel(contentType: string): string {
  return CONTENT_TYPE_LABELS[contentType] ?? contentType
}

/** Percent (0–100) of `bytes` out of `total`, 0 when total is 0. */
export function percentOf(bytes: number, total: number): number {
  if (total <= 0) {
    return 0
  }
  return (bytes / total) * 100
}

// Cache key is namespaced by the workspace identifier so multiple workspaces on the
// same origin don't clobber each other's last snapshot.
const CACHE_PREFIX = 'srn-storage-usage-snapshot-'

export function cacheKeyFor(databaseName: string): string {
  return `${CACHE_PREFIX}${databaseName}`
}

/** Persist the last completed snapshot so reopening the pane is instant. */
export function saveCachedSnapshot(databaseName: string, snapshot: StorageUsageSnapshot): void {
  try {
    localStorage.setItem(cacheKeyFor(databaseName), JSON.stringify(snapshot))
  } catch {
    /* storage full / unavailable — caching is best-effort */
  }
}

/** Read the last cached snapshot, or undefined if none / unreadable. */
export function loadCachedSnapshot(databaseName: string): StorageUsageSnapshot | undefined {
  try {
    const raw = localStorage.getItem(cacheKeyFor(databaseName))
    if (!raw) {
      return undefined
    }
    const parsed = JSON.parse(raw) as StorageUsageSnapshot
    if (parsed && typeof parsed.totalBytes === 'number' && Array.isArray(parsed.buckets)) {
      return parsed
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Standard Red Notes: robust IndexedDB storage for large vaults.
 *
 * Browsers may EVICT an origin's IndexedDB under storage pressure ("best-effort"
 * persistence) unless the origin has been granted PERSISTENT storage. For a vault
 * that may hold 100k–500k notes (multi-GB IndexedDB) eviction means silent data
 * loss, so we proactively request persistence on boot and surface the quota so the
 * user can be warned BEFORE writes start failing mid-load.
 *
 * Everything here is fully feature-detected and best-effort: the StorageManager API
 * (navigator.storage) is unavailable in some browsers / insecure contexts, so each
 * call no-ops gracefully and never throws into the boot path.
 */

const BYTES_PER_GB = 1024 * 1024 * 1024

/** Fraction of quota at/above which we consider storage "almost full". */
export const HIGH_USAGE_THRESHOLD = 0.8

export type StorageEstimateResult = {
  /** Bytes currently used by this origin (IndexedDB, caches, etc). */
  usage: number
  /** Total bytes available to this origin. */
  quota: number
  /** usage / quota in [0, 1]. 0 when quota is unknown/zero. */
  usedFraction: number
}

function storageManagerAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' && !!navigator.storage && typeof navigator.storage.estimate === 'function'
  )
}

/**
 * Request PERSISTENT storage for this origin so the browser will not evict our
 * IndexedDB under storage pressure. Guarded by `persisted()` so we never re-prompt
 * once granted. Returns the final persisted state (or undefined if unsupported).
 */
export async function requestPersistentStorage(): Promise<boolean | undefined> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.storage ||
    typeof navigator.storage.persist !== 'function' ||
    typeof navigator.storage.persisted !== 'function'
  ) {
    return undefined
  }

  try {
    const alreadyPersisted = await navigator.storage.persisted()
    if (alreadyPersisted) {
      // eslint-disable-next-line no-console
      console.log('[StorageQuota] Persistent storage already granted; IndexedDB is safe from eviction.')
      return true
    }

    const granted = await navigator.storage.persist()
    // eslint-disable-next-line no-console
    console.log(
      granted
        ? '[StorageQuota] Persistent storage granted; IndexedDB is now safe from eviction.'
        : '[StorageQuota] Persistent storage request denied; IndexedDB may be evicted under storage pressure.',
    )
    return granted
  } catch (error) {
    console.error('[StorageQuota] Persistent storage request failed', error)
    return undefined
  }
}

/**
 * Report current origin storage usage + quota via navigator.storage.estimate().
 * Returns undefined if the StorageManager API is unavailable.
 */
export async function estimateStorage(): Promise<StorageEstimateResult | undefined> {
  if (!storageManagerAvailable()) {
    return undefined
  }

  try {
    const estimate = await navigator.storage.estimate()
    const usage = estimate.usage ?? 0
    const quota = estimate.quota ?? 0
    const usedFraction = quota > 0 ? usage / quota : 0
    return { usage, quota, usedFraction }
  } catch (error) {
    console.error('[StorageQuota] estimate() failed', error)
    return undefined
  }
}

export function bytesToGb(bytes: number): number {
  return bytes / BYTES_PER_GB
}

/** Human-readable "X.XX GB" (or MB for small values), for user-facing messages. */
export function formatBytes(bytes: number): string {
  const gb = bytesToGb(bytes)
  if (gb >= 1) {
    return `${gb.toFixed(2)} GB`
  }
  const mb = bytes / (1024 * 1024)
  return `${mb.toFixed(0)} MB`
}

/**
 * True when usage is at/above the high-usage threshold (default 80% of quota).
 * False when quota is unknown (we never fabricate a warning without real numbers).
 */
export function isStorageNearlyFull(estimate: StorageEstimateResult | undefined): boolean {
  if (!estimate || estimate.quota <= 0) {
    return false
  }
  return estimate.usedFraction >= HIGH_USAGE_THRESHOLD
}

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

import { log, LoggingDomain } from '../Logging'

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
      log(LoggingDomain.Storage, '[StorageQuota] Persistent storage already granted; IndexedDB is safe from eviction.')
      return true
    }

    const granted = await navigator.storage.persist()
    log(
      LoggingDomain.Storage,
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

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/**
 * Human-readable size that AUTO-SELECTS the unit by magnitude (B / KB / MB / GB /
 * TB) so every value in the Storage pane — total, breakdown rows, largest items —
 * reads naturally (e.g. "640 B", "19.4 MB", "1.23 GB"). Whole bytes are shown
 * without decimals; KB+ get up to two decimals, trimmed of trailing zeros.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B'
  }

  let unitIndex = 0
  let value = bytes
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  if (unitIndex === 0) {
    return `${Math.round(value)} B`
  }

  const decimals = value < 10 ? 2 : value < 100 ? 1 : 0
  const formatted = value.toFixed(decimals).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
  return `${formatted} ${BYTE_UNITS[unitIndex]}`
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

/**
 * Standard Red Notes: the user-configurable "Maximum storage usage" is a SOFT,
 * advisory cap (PrefKey.StorageMaxUsageBytes; 0 == Unlimited). When the boot-time
 * storage check finds usage over that cap we surface a single toast so the user
 * learns about it even without opening the Storage pane — but at most ONCE per
 * session so it never becomes spammy, and it NEVER blocks saving or syncing.
 */
let userCapToastShownThisSession = false

/**
 * Notify (via the provided callback) that usage exceeds the user's soft cap.
 * No-ops when there is no estimate, no cap configured, usage is within the cap,
 * or the once-per-session toast was already shown. Returns whether it notified.
 */
export function maybeNotifyStorageCapExceeded(
  estimate: StorageEstimateResult | undefined,
  capBytes: number,
  notify: (message: string) => void,
): boolean {
  if (!estimate || !Number.isFinite(capBytes) || capBytes <= 0 || estimate.usage <= capBytes) {
    return false
  }

  log(
    LoggingDomain.Storage,
    `[StorageQuota] Usage ${formatBytes(estimate.usage)} exceeds the configured soft limit of ` +
      `${formatBytes(capBytes)} (advisory only — writes are never blocked).`,
  )

  if (userCapToastShownThisSession) {
    return false
  }
  userCapToastShownThisSession = true

  notify(
    `Local storage usage (${formatBytes(estimate.usage)}) exceeds your configured limit of ` +
      `${formatBytes(capBytes)}. This limit is advisory — saving and syncing are not blocked. ` +
      'Free up space or raise the limit in Preferences → Storage.',
  )
  return true
}

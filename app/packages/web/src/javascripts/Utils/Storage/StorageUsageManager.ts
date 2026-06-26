// Main-thread client for the storage-usage worker.
//
// Spins up storageUsage.worker.ts to measure the app's IndexedDB items store, the
// service-worker Cache Storage, and any auxiliary IndexedDB databases off the main
// thread, then MERGES in the two things the worker can't see itself:
//
//   - localStorage usage. localStorage is exposed only on the main thread (not in
//     workers), so we sum key+value byte lengths here.
//   - The synthetic "Unaccounted" remainder = origin estimate.usage - everything we
//     measured, so the breakdown ALWAYS reconciles to the reported total (never
//     "100MB total but nothing shown").
//
// Worker construction MIRRORS DecryptionPool / ThreadedSearchIndex: worker-loader
// rewrites the `*.worker.ts` import into a Worker constructor at build time (the
// `/\.worker\.tsx?$/` rule in web.webpack.config.js). We import it as a namespace
// and pick `.default ?? namespace` so `new()` actually constructs (worker-loader's
// default esModule output puts the constructor on `.default`). The constructor only
// runs when `typeof Worker !== 'undefined'`, so jest/jsdom never evaluates it.

import {
  LOCAL_STORAGE_SOURCE_ID,
  StorageSource,
  StorageUsageSnapshot,
  StorageUsageWorkerRequest,
  StorageUsageWorkerResponse,
  UNACCOUNTED_SOURCE_ID,
} from './storageUsageWorkerProtocol'
import * as StorageUsageWorkerModule from './storageUsage.worker'

const StorageUsageWorker = ((StorageUsageWorkerModule as { default?: { new (): Worker } }).default ??
  (StorageUsageWorkerModule as unknown as { new (): Worker })) as { new (): Worker }

const DEFAULT_TOP_N = 20
const DEFAULT_CHUNK_SIZE = 2000

export interface StorageUsageScanCallbacks {
  /** Called for every progressive snapshot and the final one (`snapshot.done`). */
  onSnapshot: (snapshot: StorageUsageSnapshot) => void
  /** Called once if the scan can't run / fails; the UI should fall back. */
  onError?: (message: string) => void
}

export interface StorageUsageScanHandle {
  /** Abort the in-flight scan and release the worker. */
  cancel: () => void
}

export interface StorageUsageScanOptions {
  topN?: number
  chunkSize?: number
  /**
   * Origin usage from navigator.storage.estimate(). When provided, an
   * "Unaccounted" source is synthesized so the breakdown reconciles to it.
   */
  estimatedUsage?: number
}

/** True when a real scan can be offloaded to a worker that can reach IndexedDB. */
export function isStorageUsageScanAvailable(): boolean {
  return typeof Worker !== 'undefined' && typeof indexedDB !== 'undefined'
}

/**
 * Measure localStorage usage on the main thread (UTF-16: 2 bytes per char for both
 * key and value). Best-effort — returns 0 if localStorage is unavailable.
 */
export function measureLocalStorageBytes(): number {
  if (typeof localStorage === 'undefined') {
    return 0
  }
  try {
    let bytes = 0
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key == null) {
        continue
      }
      const value = localStorage.getItem(key) ?? ''
      bytes += (key.length + value.length) * 2
    }
    return bytes
  } catch {
    return 0
  }
}

/**
 * Merge the main-thread-only sources (localStorage + the Unaccounted remainder)
 * into a worker snapshot so it reconciles to the origin total. Returns a NEW
 * snapshot; the input is left untouched.
 */
function mergeMainThreadSources(
  snapshot: StorageUsageSnapshot,
  localStorageBytes: number,
  estimatedUsage: number | undefined,
): StorageUsageSnapshot {
  const sources: StorageSource[] = snapshot.sources.filter(
    (source) => source.id !== LOCAL_STORAGE_SOURCE_ID && source.id !== UNACCOUNTED_SOURCE_ID,
  )

  if (localStorageBytes > 0) {
    sources.push({
      id: LOCAL_STORAGE_SOURCE_ID,
      label: 'Local settings',
      bytes: localStorageBytes,
      count: 0,
    })
  }

  const measured = sources.reduce((sum, source) => sum + source.bytes, 0)

  if (typeof estimatedUsage === 'number' && estimatedUsage > 0) {
    const remainder = estimatedUsage - measured
    // Only show a remainder once everything has been measured (snapshot.done);
    // during the scan a partial sum would produce a misleadingly huge "Unaccounted".
    if (snapshot.done && remainder > 0) {
      sources.push({
        id: UNACCOUNTED_SOURCE_ID,
        label: 'Other / unaccounted',
        bytes: remainder,
        count: 0,
      })
    }
  }

  return { ...snapshot, sources }
}

/**
 * Start a progressive scan of `databaseName` (the workspace identifier). Returns a
 * handle to cancel it, or null when scanning isn't available (caller should fall
 * back to total-only via StorageQuota). Each posted snapshot is self-contained, so
 * the callback can render it directly without accumulating state.
 */
export function scanStorageUsage(
  databaseName: string,
  callbacks: StorageUsageScanCallbacks,
  options: StorageUsageScanOptions = {},
): StorageUsageScanHandle | null {
  if (!isStorageUsageScanAvailable()) {
    return null
  }

  let worker: Worker
  try {
    worker = new StorageUsageWorker()
  } catch (error) {
    callbacks.onError?.(error instanceof Error ? error.message : 'worker construction failed')
    return null
  }

  const requestId = 1
  let finished = false
  const localStorageBytes = measureLocalStorageBytes()

  const teardown = (): void => {
    if (finished) {
      return
    }
    finished = true
    worker.terminate()
  }

  const relay = (snapshot: StorageUsageSnapshot): void => {
    callbacks.onSnapshot(mergeMainThreadSources(snapshot, localStorageBytes, options.estimatedUsage))
  }

  worker.onmessage = (event: MessageEvent<StorageUsageWorkerResponse>) => {
    const response = event.data
    if (response.requestId !== requestId) {
      return
    }
    if (response.type === 'progress') {
      relay(response.snapshot)
    } else if (response.type === 'done') {
      relay(response.snapshot)
      teardown()
    } else if (response.type === 'error') {
      callbacks.onError?.(response.message)
      teardown()
    }
  }

  worker.onerror = () => {
    callbacks.onError?.('Storage scan worker errored')
    teardown()
  }

  const request: StorageUsageWorkerRequest = {
    type: 'scan',
    requestId,
    databaseName,
    topN: options.topN ?? DEFAULT_TOP_N,
    chunkSize: options.chunkSize ?? DEFAULT_CHUNK_SIZE,
  }
  worker.postMessage(request)

  return { cancel: teardown }
}

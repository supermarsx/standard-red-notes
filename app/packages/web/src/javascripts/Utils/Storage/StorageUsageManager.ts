// Main-thread client for the storage-usage worker.
//
// Spins up storageUsage.worker.ts to cursor the app's IndexedDB read-only and
// stream progressive snapshots (total bytes, per-content_type buckets, top-N
// biggest entries) back to a caller callback. The worker keeps the UI thread free
// during a multi-GB scan; this manager just relays its messages and tears the
// worker down when finished.
//
// Worker construction MIRRORS DecryptionPool / ThreadedSearchIndex: worker-loader
// rewrites the `*.worker.ts` import into a Worker constructor at build time (the
// `/\.worker\.tsx?$/` rule in web.webpack.config.js). We import it as a namespace
// and pick `.default ?? namespace` so `new()` actually constructs (worker-loader's
// default esModule output puts the constructor on `.default`). The constructor only
// runs when `typeof Worker !== 'undefined'`, so jest/jsdom never evaluates it.

import {
  StorageUsageSnapshot,
  StorageUsageWorkerRequest,
  StorageUsageWorkerResponse,
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

/** True when a real scan can be offloaded to a worker that can reach IndexedDB. */
export function isStorageUsageScanAvailable(): boolean {
  return typeof Worker !== 'undefined' && typeof indexedDB !== 'undefined'
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
  options: { topN?: number; chunkSize?: number } = {},
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

  const teardown = (): void => {
    if (finished) {
      return
    }
    finished = true
    worker.terminate()
  }

  worker.onmessage = (event: MessageEvent<StorageUsageWorkerResponse>) => {
    const response = event.data
    if (response.requestId !== requestId) {
      return
    }
    if (response.type === 'progress') {
      callbacks.onSnapshot(response.snapshot)
    } else if (response.type === 'done') {
      callbacks.onSnapshot(response.snapshot)
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

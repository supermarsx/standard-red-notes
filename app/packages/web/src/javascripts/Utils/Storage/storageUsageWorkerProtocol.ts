// Message protocol shared between the main thread and the storage-usage Web
// Worker (storageUsage.worker.ts). Kept dependency-free so both sides import the
// exact same types without dragging the worker's runtime into the main bundle.

/** A single content_type bucket: how many entries and how many bytes on disk. */
export interface StorageTypeBucket {
  contentType: string
  bytes: number
  count: number
}

/** One of the largest stored entries (raw ENCRYPTED size — never decrypted). */
export interface StorageLargestItem {
  uuid: string
  contentType: string
  /** Best-effort label derivable WITHOUT decrypting; falls back to the uuid. */
  title: string
  bytes: number
}

/**
 * A rolling snapshot of the scan. Posted progressively while scanning (`done:
 * false`) and once more at the end (`done: true`). Always self-contained so the UI
 * can render any snapshot it receives without accumulating state.
 */
export interface StorageUsageSnapshot {
  /** Total raw bytes of every stored entry seen so far. */
  totalBytes: number
  /** Number of entries scanned so far. */
  itemCount: number
  /** Per-content_type aggregates, unsorted. */
  buckets: StorageTypeBucket[]
  /** Top-N biggest entries seen so far, sorted largest-first. */
  largest: StorageLargestItem[]
  /** True only for the terminal message of a scan. */
  done: boolean
}

/** Messages posted FROM the main thread TO the worker. */
export type StorageUsageWorkerRequest = {
  type: 'scan'
  requestId: number
  /** IndexedDB database name to open read-only (the workspace identifier). */
  databaseName: string
  /** How many of the largest entries to retain. */
  topN: number
  /** Post a partial snapshot every `chunkSize` entries. */
  chunkSize: number
}

/** Messages posted FROM the worker BACK TO the main thread. */
export type StorageUsageWorkerResponse =
  | { type: 'progress'; requestId: number; snapshot: StorageUsageSnapshot }
  | { type: 'done'; requestId: number; snapshot: StorageUsageSnapshot }
  | { type: 'error'; requestId: number; message: string }

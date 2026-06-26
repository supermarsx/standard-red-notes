// Message protocol shared between the main thread and the storage-usage Web
// Worker (storageUsage.worker.ts). Kept dependency-free so both sides import the
// exact same types without dragging the worker's runtime into the main bundle.

/** A single content_type bucket: how many entries and how many bytes on disk. */
export interface StorageTypeBucket {
  contentType: string
  bytes: number
  count: number
}

/**
 * A top-level storage SOURCE. The breakdown shown to the user is the union of
 * these sources, and they always reconcile to the reported total via an
 * `unaccounted` source. Sources are distinct from per-content_type `buckets`,
 * which only break the items-store source down further.
 */
export interface StorageSource {
  /** Stable id used to render and to special-case the synthetic `unaccounted`. */
  id: string
  /** Friendly display label. */
  label: string
  bytes: number
  /** Entry count where meaningful (items / cache entries); 0 otherwise. */
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
  /** Total raw bytes of every stored entry seen so far (items store only). */
  totalBytes: number
  /** Number of items-store entries scanned so far. */
  itemCount: number
  /** Per-content_type aggregates of the items store, unsorted. */
  buckets: StorageTypeBucket[]
  /**
   * Top-level breakdown sources (items, app cache, other databases, and — once
   * merged on the main thread — localStorage + the synthetic Unaccounted
   * remainder). Sums to the reported origin total.
   */
  sources: StorageSource[]
  /** Top-N biggest entries seen so far, sorted largest-first. */
  largest: StorageLargestItem[]
  /** True only for the terminal message of a scan. */
  done: boolean
}

/** Synthetic source ids the UI / manager special-case. */
export const ITEMS_SOURCE_ID = 'items'
export const CACHE_SOURCE_ID = 'cache'
export const LOCAL_STORAGE_SOURCE_ID = 'localStorage'
export const OTHER_DB_SOURCE_ID = 'otherDatabases'
export const UNACCOUNTED_SOURCE_ID = 'unaccounted'

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

// Web Worker that measures local on-disk storage usage off the main thread.
//
// It produces a COMPLETE breakdown of where an origin's bytes live, so the pane
// never shows "100MB total but nothing in the breakdown". It measures:
//
//   1. The app's OWN IndexedDB items store ('items', keyed by 'uuid') READ-ONLY,
//      cursored entry-by-entry. Each entry is an ENCRYPTED payload; we measure its
//      raw on-disk weight and NEVER decrypt — the encrypted size is the real disk
//      usage. Broken down per content_type, with a fixed top-N largest list.
//   2. Cache Storage (the service worker's cache holding the JS bundles, fonts and
//      offline component assets — usually the biggest consumer). The Cache API is
//      available inside workers, so each cache's entries are summed here.
//   3. Any OTHER IndexedDB databases beyond the items DB (where
//      indexedDB.databases() is supported), summed coarsely.
//
// localStorage is MAIN-THREAD ONLY (not exposed to workers), so it is measured by
// StorageUsageManager on the main thread and merged into the snapshot there, along
// with the synthetic "Unaccounted" remainder = estimate.usage - sum(measured).
//
// While scanning the items store we keep only bounded running aggregates (a total,
// a per-content_type map, and a fixed top-N list), so a multi-GB vault never
// materializes resident. Partial snapshots are posted every `chunkSize` entries so
// the Storage pane fills in live, and a terminal 'done' message is posted when all
// sources are measured.

import {
  ITEMS_SOURCE_ID,
  StorageLargestItem,
  StorageSource,
  StorageTypeBucket,
  StorageUsageSnapshot,
  StorageUsageWorkerRequest,
  StorageUsageWorkerResponse,
} from './storageUsageWorkerProtocol'

const ctx = self as unknown as DedicatedWorkerGlobalScope

const STORE_NAME = 'items'

/**
 * Idle timeout for a single IndexedDB cursor scan. Reset on every entry, so a large
 * but PROGRESSING scan is never killed — only a genuinely wedged cursor (no progress
 * for this long) trips it, resolving the scan with whatever it has so far instead of
 * hanging the worker forever.
 */
const CURSOR_IDLE_TIMEOUT_MS = 30_000

/** Overall deadline for one auxiliary Cache/DB source measurement. */
const SOURCE_TIMEOUT_MS = 30_000

/**
 * Master deadline for the whole scan. Independent of the individual awaits, so even if
 * a source hangs in a way the per-op timeouts miss, a terminal 'done' is still posted
 * and the main-thread pane leaves its loading state — it is NEVER left stuck.
 */
const MASTER_SCAN_TIMEOUT_MS = 120_000

const post = (message: StorageUsageWorkerResponse): void => {
  ctx.postMessage(message)
}

/** Resolve to `fallback` if `promise` doesn't settle within `ms` (never rejects). */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        resolve(fallback)
      }
    }, ms)
    promise.then(
      (value) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve(value)
        }
      },
      () => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve(fallback)
        }
      },
    )
  })
}

/**
 * Approximate the on-disk byte weight of a stored entry. The encrypted body lives
 * in string fields (content/items_key_content) plus small metadata; JSON-stringify
 * length is a stable, decrypt-free proxy for the raw value's size. Falls back to a
 * coarse estimate if the value can't be stringified (e.g. cyclic — never expected
 * for stored payloads).
 */
function sizeOfEntry(value: unknown): number {
  try {
    const json = JSON.stringify(value)
    return json ? json.length : 0
  } catch {
    return 0
  }
}

/**
 * Derive a human label WITHOUT decrypting. Stored payloads keep some plaintext
 * metadata; we never touch the encrypted `content`. Most encrypted items have no
 * safe title, so we fall back to the uuid.
 */
function labelForEntry(value: Record<string, unknown>, uuid: string): string {
  const candidate = value['title'] ?? value['name']
  if (typeof candidate === 'string' && candidate.length > 0) {
    return candidate
  }
  return uuid
}

/** Insert into a largest-first, capped top-N list (cheap for small N). */
function insertTopN(list: StorageLargestItem[], item: StorageLargestItem, topN: number): void {
  if (list.length < topN) {
    list.push(item)
    list.sort((a, b) => b.bytes - a.bytes)
    return
  }
  if (item.bytes <= list[list.length - 1].bytes) {
    return
  }
  list[list.length - 1] = item
  list.sort((a, b) => b.bytes - a.bytes)
}

interface ScanState {
  totalBytes: number
  itemCount: number
  buckets: Map<string, StorageTypeBucket>
  largest: StorageLargestItem[]
  /** Non-items sources measured separately (cache, other databases). */
  extraSources: StorageSource[]
}

function buildSnapshot(state: ScanState, done: boolean): StorageUsageSnapshot {
  const itemsSource: StorageSource = {
    id: ITEMS_SOURCE_ID,
    label: 'Items database',
    bytes: state.totalBytes,
    count: state.itemCount,
  }
  return {
    totalBytes: state.totalBytes,
    itemCount: state.itemCount,
    buckets: Array.from(state.buckets.values()).map((bucket) => ({ ...bucket })),
    sources: [itemsSource, ...state.extraSources.map((source) => ({ ...source }))],
    largest: state.largest.map((item) => ({ ...item })),
    done,
  }
}

/**
 * Friendly label for a Cache Storage cache name, so the breakdown says WHAT is
 * cached (app shell / fonts / images / runtime) instead of an opaque cache key.
 * Unknown names pass through so nothing is hidden.
 */
function friendlyCacheLabel(name: string): string {
  const lower = name.toLowerCase()
  if (lower.startsWith('srn-shell') || lower.includes('shell') || lower.includes('precache')) {
    return 'Cache — app shell (offline)'
  }
  if (lower.includes('font')) {
    return 'Cache — fonts'
  }
  if (lower.includes('image') || lower.includes('img')) {
    return 'Cache — images'
  }
  if (lower.includes('workbox') || lower.includes('runtime')) {
    return 'Cache — runtime assets'
  }
  return `Cache — ${name}`
}

/** Sum the on-disk body size of one cache's entries (Content-Length, blob fallback). */
async function measureOneCache(cacheName: string): Promise<{ bytes: number; count: number }> {
  let bytes = 0
  let count = 0
  const cache = await caches.open(cacheName)
  const requests = await cache.keys()
  for (const request of requests) {
    count += 1
    try {
      const response = await cache.match(request)
      if (!response) {
        continue
      }
      const contentLength = response.headers.get('content-length')
      if (contentLength) {
        const parsed = Number(contentLength)
        if (Number.isFinite(parsed) && parsed > 0) {
          bytes += parsed
          continue
        }
      }
      const blob = await response.clone().blob()
      bytes += blob.size
    } catch {
      /* one bad cache entry shouldn't abort the scan */
    }
  }
  return { bytes, count }
}

/**
 * Produce ONE source PER named Cache Storage cache (a per-cache breakdown), rather
 * than a single "App cache" lump — so the user sees the app-shell cache vs fonts vs
 * runtime caches separately. The Cache API IS available in workers. We prefer the
 * Content-Length header (cheap) and fall back to reading the response body as a blob
 * (`response.clone().blob().size`) when it's missing (opaque/chunked responses).
 * Best-effort: any failure yields 0 bytes for the affected entry/cache rather than
 * aborting the whole scan. Empty caches are omitted from the breakdown.
 */
async function measureCacheStorages(): Promise<StorageSource[]> {
  if (typeof caches === 'undefined' || typeof caches.keys !== 'function') {
    return []
  }

  const sources: StorageSource[] = []
  try {
    const cacheNames = await caches.keys()
    for (const cacheName of cacheNames) {
      try {
        const { bytes, count } = await measureOneCache(cacheName)
        if (bytes === 0 && count === 0) {
          continue
        }
        sources.push({ id: `cache:${cacheName}`, label: friendlyCacheLabel(cacheName), bytes, count })
      } catch {
        /* skip a cache we can't open */
      }
    }
  } catch {
    return sources
  }

  return sources
}

/**
 * Friendly label for an auxiliary IndexedDB database name, so known stores are named
 * (cached files, encryption keychain, search index) instead of appearing as raw db
 * keys. Unknown databases pass through under a generic "Database — <name>" label so
 * nothing is hidden. The items DB name is passed so its `<id>-local-files` sibling is
 * recognized regardless of workspace identifier.
 */
function friendlyDatabaseLabel(name: string, itemsDbName: string): string {
  const lower = name.toLowerCase()
  if (name === `${itemsDbName}-local-files` || lower.endsWith('-local-files') || lower.includes('local-files')) {
    return 'Cached files (downloaded)'
  }
  if (lower.includes('keychain')) {
    return 'Encryption keychain'
  }
  if (lower.includes('search') || lower.includes('index')) {
    return 'Search index'
  }
  return `Database — ${name}`
}

/**
 * Measure any OTHER IndexedDB databases besides the items DB, emitting ONE source
 * PER database (an itemized breakdown) rather than a single "Other local databases"
 * lump — so cached files, the encryption keychain and any search index are each
 * named. indexedDB.databases() is not universally supported and doesn't expose
 * sizes, so we open each extra DB and sum the stringified weight of every record.
 * Best-effort and bounded by the fact that auxiliary DBs are small; returns [] when
 * unsupported. Empty databases are omitted.
 */
async function measureOtherDatabases(itemsDbName: string): Promise<StorageSource[]> {
  const idbAny = indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> }
  if (typeof idbAny.databases !== 'function') {
    return []
  }

  let infos: { name?: string }[]
  try {
    infos = await idbAny.databases()
  } catch {
    return []
  }

  const otherNames = infos
    .map((info) => info.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0 && name !== itemsDbName)

  const sources: StorageSource[] = []
  for (const name of otherNames) {
    try {
      let entryCount = 0
      const bytes = await sumDatabaseBytes(name, (entries) => {
        entryCount = entries
      })
      if (bytes === 0 && entryCount === 0) {
        continue
      }
      sources.push({ id: `db:${name}`, label: friendlyDatabaseLabel(name, itemsDbName), bytes, count: entryCount })
    } catch {
      /* skip databases we can't open */
    }
  }

  return sources
}

/** Open `name` read-only and sum the stringified byte weight of every record in every store. */
function sumDatabaseBytes(name: string, onEntries: (entries: number) => void): Promise<number> {
  return new Promise((resolve) => {
    let openRequest: IDBOpenDBRequest
    try {
      openRequest = indexedDB.open(name)
    } catch {
      resolve(0)
      return
    }

    let db: IDBDatabase | null = null
    let done = false
    let bytes = 0
    let entries = 0

    // Idle watchdog: if the open never fires or a cursor wedges, resolve with what we
    // have so the caller (and the whole scan) can't hang on this database.
    let watchdog = setTimeout(finishAll, CURSOR_IDLE_TIMEOUT_MS)
    function bumpWatchdog(): void {
      clearTimeout(watchdog)
      watchdog = setTimeout(finishAll, CURSOR_IDLE_TIMEOUT_MS)
    }
    function finishAll(): void {
      if (done) {
        return
      }
      done = true
      clearTimeout(watchdog)
      onEntries(entries)
      try {
        db?.close()
      } catch {
        /* already closed */
      }
      resolve(bytes)
    }

    openRequest.onerror = () => finishAll()
    openRequest.onsuccess = () => {
      db = openRequest.result
      const storeNames = Array.from(db.objectStoreNames)
      if (storeNames.length === 0) {
        finishAll()
        return
      }

      let remaining = storeNames.length

      const finishStore = () => {
        remaining -= 1
        if (remaining === 0) {
          finishAll()
        }
      }

      for (const storeName of storeNames) {
        try {
          const transaction = db.transaction(storeName, 'readonly')
          const cursorRequest = transaction.objectStore(storeName).openCursor()
          cursorRequest.onerror = finishStore
          cursorRequest.onsuccess = () => {
            if (done) {
              return
            }
            const cursor = cursorRequest.result
            if (cursor) {
              bytes += sizeOfEntry(cursor.value)
              entries += 1
              bumpWatchdog()
              cursor.continue()
            } else {
              finishStore()
            }
          }
        } catch {
          finishStore()
        }
      }
    }
  })
}

/** Cursor the items store, streaming progressive snapshots, then resolve. */
function scanItemsStore(
  request: Extract<StorageUsageWorkerRequest, { type: 'scan' }>,
  state: ScanState,
): Promise<void> {
  const { requestId, databaseName, topN, chunkSize } = request

  return new Promise((resolve) => {
    let openRequest: IDBOpenDBRequest
    try {
      openRequest = indexedDB.open(databaseName)
    } catch {
      resolve()
      return
    }

    let db: IDBDatabase | null = null
    let done = false

    // Idle watchdog: reset on every entry, so only a genuinely wedged cursor (no
    // progress within the window) resolves early with the partial aggregates gathered
    // so far — the scan then continues to caches/other DBs and still posts 'done'.
    let watchdog = setTimeout(finish, CURSOR_IDLE_TIMEOUT_MS)
    function bumpWatchdog(): void {
      clearTimeout(watchdog)
      watchdog = setTimeout(finish, CURSOR_IDLE_TIMEOUT_MS)
    }
    function finish(): void {
      if (done) {
        return
      }
      done = true
      clearTimeout(watchdog)
      try {
        db?.close()
      } catch {
        /* already closed */
      }
      resolve()
    }

    openRequest.onerror = () => finish()
    openRequest.onsuccess = () => {
      db = openRequest.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        finish()
        return
      }

      let cursorRequest: IDBRequest<IDBCursorWithValue | null>
      try {
        const transaction = db.transaction(STORE_NAME, 'readonly')
        cursorRequest = transaction.objectStore(STORE_NAME).openCursor()
      } catch {
        finish()
        return
      }

      let sinceLastPost = 0

      cursorRequest.onerror = () => finish()

      cursorRequest.onsuccess = () => {
        if (done) {
          return
        }
        const cursor = cursorRequest.result
        if (cursor) {
          const value = cursor.value as Record<string, unknown>
          const bytes = sizeOfEntry(value)
          const contentType = typeof value['content_type'] === 'string' ? (value['content_type'] as string) : 'Unknown'
          const uuid = typeof value['uuid'] === 'string' ? (value['uuid'] as string) : String(cursor.primaryKey)

          state.totalBytes += bytes
          state.itemCount += 1
          sinceLastPost += 1

          const bucket = state.buckets.get(contentType)
          if (bucket) {
            bucket.bytes += bytes
            bucket.count += 1
          } else {
            state.buckets.set(contentType, { contentType, bytes, count: 1 })
          }

          insertTopN(state.largest, { uuid, contentType, title: labelForEntry(value, uuid), bytes }, topN)

          if (sinceLastPost >= chunkSize) {
            sinceLastPost = 0
            post({ type: 'progress', requestId, snapshot: buildSnapshot(state, false) })
          }

          bumpWatchdog()
          cursor.continue()
        } else {
          finish()
        }
      }
    }
  })
}

async function scan(request: Extract<StorageUsageWorkerRequest, { type: 'scan' }>): Promise<void> {
  const { requestId, databaseName } = request

  if (typeof indexedDB === 'undefined') {
    post({ type: 'error', requestId, message: 'IndexedDB unavailable in worker' })
    return
  }

  const state: ScanState = {
    totalBytes: 0,
    itemCount: 0,
    buckets: new Map<string, StorageTypeBucket>(),
    largest: [],
    extraSources: [],
  }

  // Post the terminal 'done' at most once. The master timeout below and the normal
  // completion race to call this; whoever wins, the main-thread pane leaves loading.
  let finished = false
  const postDone = (): void => {
    if (finished) {
      return
    }
    finished = true
    post({ type: 'done', requestId, snapshot: buildSnapshot(state, true) })
  }

  // Master deadline, independent of the awaits below: even if a source hangs in a way
  // the per-op timeouts miss, a terminal 'done' (with whatever we have) is still sent
  // so the pane is NEVER stuck loading.
  const master = setTimeout(postDone, MASTER_SCAN_TIMEOUT_MS)

  try {
    // Items store first so the per-type breakdown + largest list stream in live.
    await scanItemsStore(request, state)
    if (finished) {
      return
    }
    post({ type: 'progress', requestId, snapshot: buildSnapshot(state, false) })

    // Cache Storage is usually the biggest consumer (JS bundles/fonts/assets) — one
    // source per named cache so the user sees WHAT is cached, not just a lump.
    const cacheSources = await withTimeout(measureCacheStorages(), SOURCE_TIMEOUT_MS, [])
    if (finished) {
      return
    }
    if (cacheSources.length > 0) {
      state.extraSources.push(...cacheSources)
      post({ type: 'progress', requestId, snapshot: buildSnapshot(state, false) })
    }

    // Any auxiliary IndexedDB databases beyond the items DB — one named source each
    // (cached files, encryption keychain, search index, ...).
    const otherDbSources = await withTimeout(measureOtherDatabases(databaseName), SOURCE_TIMEOUT_MS, [])
    if (finished) {
      return
    }
    if (otherDbSources.length > 0) {
      state.extraSources.push(...otherDbSources)
      post({ type: 'progress', requestId, snapshot: buildSnapshot(state, false) })
    }

    postDone()
  } finally {
    clearTimeout(master)
    // Belt-and-suspenders: if we exited without a terminal message (unexpected), emit
    // one so the pane never hangs.
    postDone()
  }
}

ctx.onmessage = (event: MessageEvent<StorageUsageWorkerRequest>): void => {
  const request = event.data
  if (request.type === 'scan') {
    scan(request).catch((error) => {
      post({
        type: 'error',
        requestId: request.requestId,
        message: error instanceof Error ? error.message : 'scan failed',
      })
    })
  }
}

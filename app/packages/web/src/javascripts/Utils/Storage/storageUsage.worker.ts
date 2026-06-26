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
  CACHE_SOURCE_ID,
  ITEMS_SOURCE_ID,
  OTHER_DB_SOURCE_ID,
  StorageLargestItem,
  StorageSource,
  StorageTypeBucket,
  StorageUsageSnapshot,
  StorageUsageWorkerRequest,
  StorageUsageWorkerResponse,
} from './storageUsageWorkerProtocol'

const ctx = self as unknown as DedicatedWorkerGlobalScope

const STORE_NAME = 'items'

const post = (message: StorageUsageWorkerResponse): void => {
  ctx.postMessage(message)
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
 * Sum every entry across every Cache Storage cache. The Cache API IS available in
 * workers. We prefer the Content-Length header (cheap) and fall back to reading the
 * response body as a blob (`response.clone().blob()).size`) when it's missing —
 * e.g. opaque or chunked responses. Best-effort: any failure yields 0 bytes for the
 * affected entry rather than aborting the whole scan.
 */
async function measureCacheStorage(): Promise<StorageSource | undefined> {
  if (typeof caches === 'undefined' || typeof caches.keys !== 'function') {
    return undefined
  }

  let bytes = 0
  let count = 0
  try {
    const cacheNames = await caches.keys()
    for (const cacheName of cacheNames) {
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
    }
  } catch {
    return undefined
  }

  return { id: CACHE_SOURCE_ID, label: 'App cache (offline assets)', bytes, count }
}

/**
 * Coarsely measure any OTHER IndexedDB databases besides the items DB so they show
 * up in the breakdown instead of falling into "Unaccounted". indexedDB.databases()
 * is not universally supported and doesn't expose sizes, so we open each extra DB
 * and sum the stringified weight of every record. Best-effort and bounded by the
 * fact that auxiliary DBs are small; returns undefined when unsupported.
 */
async function measureOtherDatabases(itemsDbName: string): Promise<StorageSource | undefined> {
  const idbAny = indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> }
  if (typeof idbAny.databases !== 'function') {
    return undefined
  }

  let infos: { name?: string }[]
  try {
    infos = await idbAny.databases()
  } catch {
    return undefined
  }

  const otherNames = infos
    .map((info) => info.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0 && name !== itemsDbName)

  if (otherNames.length === 0) {
    return undefined
  }

  let bytes = 0
  let count = 0
  for (const name of otherNames) {
    try {
      bytes += await sumDatabaseBytes(name, (entries) => {
        count += entries
      })
    } catch {
      /* skip databases we can't open */
    }
  }

  if (bytes === 0 && count === 0) {
    return undefined
  }

  return { id: OTHER_DB_SOURCE_ID, label: 'Other local databases', bytes, count }
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

    openRequest.onerror = () => resolve(0)
    openRequest.onsuccess = () => {
      const db = openRequest.result
      const storeNames = Array.from(db.objectStoreNames)
      if (storeNames.length === 0) {
        db.close()
        resolve(0)
        return
      }

      let bytes = 0
      let entries = 0
      let remaining = storeNames.length

      const finishStore = () => {
        remaining -= 1
        if (remaining === 0) {
          onEntries(entries)
          db.close()
          resolve(bytes)
        }
      }

      for (const storeName of storeNames) {
        try {
          const transaction = db.transaction(storeName, 'readonly')
          const cursorRequest = transaction.objectStore(storeName).openCursor()
          cursorRequest.onerror = finishStore
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result
            if (cursor) {
              bytes += sizeOfEntry(cursor.value)
              entries += 1
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

    openRequest.onerror = () => resolve()
    openRequest.onsuccess = () => {
      const db = openRequest.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.close()
        resolve()
        return
      }

      let cursorRequest: IDBRequest<IDBCursorWithValue | null>
      try {
        const transaction = db.transaction(STORE_NAME, 'readonly')
        cursorRequest = transaction.objectStore(STORE_NAME).openCursor()
      } catch {
        db.close()
        resolve()
        return
      }

      let sinceLastPost = 0

      cursorRequest.onerror = () => {
        db.close()
        resolve()
      }

      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result
        if (cursor) {
          const value = cursor.value as Record<string, unknown>
          const bytes = sizeOfEntry(value)
          const contentType =
            typeof value['content_type'] === 'string' ? (value['content_type'] as string) : 'Unknown'
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

          cursor.continue()
        } else {
          db.close()
          resolve()
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

  // Items store first so the per-type breakdown + largest list stream in live.
  await scanItemsStore(request, state)
  post({ type: 'progress', requestId, snapshot: buildSnapshot(state, false) })

  // Cache Storage is usually the biggest consumer (JS bundles/fonts/assets).
  const cacheSource = await measureCacheStorage()
  if (cacheSource) {
    state.extraSources.push(cacheSource)
    post({ type: 'progress', requestId, snapshot: buildSnapshot(state, false) })
  }

  // Any auxiliary IndexedDB databases beyond the items DB.
  const otherDbSource = await measureOtherDatabases(databaseName)
  if (otherDbSource) {
    state.extraSources.push(otherDbSource)
    post({ type: 'progress', requestId, snapshot: buildSnapshot(state, false) })
  }

  post({ type: 'done', requestId, snapshot: buildSnapshot(state, true) })
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

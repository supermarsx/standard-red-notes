// Web Worker that measures local IndexedDB disk usage off the main thread.
//
// It opens the app's OWN IndexedDB (the same `identifier`-named database the
// Database.ts layer writes to, one object store 'items' keyed by 'uuid') READ-ONLY
// and cursors every stored entry. Each entry is an ENCRYPTED payload; we measure
// its raw on-disk weight (the byte length of the stored value) and NEVER decrypt —
// the encrypted size is the real disk usage. While scanning we keep only bounded
// running aggregates (a total, a per-content_type map, and a fixed top-N list), so
// a multi-GB vault never materializes resident. Partial snapshots are posted every
// `chunkSize` entries so the Storage pane fills in live, and a terminal 'done'
// message is posted when the cursor exhausts.
//
// The matching main-thread client is StorageUsageManager.ts, which falls back to
// total-only (StorageQuota) when Workers / IndexedDB are unavailable.

import {
  StorageLargestItem,
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

function buildSnapshot(
  totalBytes: number,
  itemCount: number,
  buckets: Map<string, StorageTypeBucket>,
  largest: StorageLargestItem[],
  done: boolean,
): StorageUsageSnapshot {
  return {
    totalBytes,
    itemCount,
    buckets: Array.from(buckets.values()).map((bucket) => ({ ...bucket })),
    largest: largest.map((item) => ({ ...item })),
    done,
  }
}

function scan(request: Extract<StorageUsageWorkerRequest, { type: 'scan' }>): void {
  const { requestId, databaseName, topN, chunkSize } = request

  if (typeof indexedDB === 'undefined') {
    post({ type: 'error', requestId, message: 'IndexedDB unavailable in worker' })
    return
  }

  let totalBytes = 0
  let itemCount = 0
  let sinceLastPost = 0
  const buckets = new Map<string, StorageTypeBucket>()
  const largest: StorageLargestItem[] = []

  const openRequest = indexedDB.open(databaseName)

  openRequest.onerror = () => {
    post({ type: 'error', requestId, message: 'Unable to open database for sizing' })
  }

  openRequest.onsuccess = () => {
    const db = openRequest.result
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      // Nothing to scan — report an empty but successful snapshot.
      post({ type: 'done', requestId, snapshot: buildSnapshot(0, 0, buckets, largest, true) })
      db.close()
      return
    }

    let cursorRequest: IDBRequest<IDBCursorWithValue | null>
    try {
      const transaction = db.transaction(STORE_NAME, 'readonly')
      cursorRequest = transaction.objectStore(STORE_NAME).openCursor()
    } catch (error) {
      post({ type: 'error', requestId, message: error instanceof Error ? error.message : 'cursor failed' })
      db.close()
      return
    }

    cursorRequest.onerror = () => {
      post({ type: 'error', requestId, message: 'Cursor error while scanning' })
      db.close()
    }

    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result
      if (cursor) {
        const value = cursor.value as Record<string, unknown>
        const bytes = sizeOfEntry(value)
        const contentType = typeof value['content_type'] === 'string' ? (value['content_type'] as string) : 'Unknown'
        const uuid = typeof value['uuid'] === 'string' ? (value['uuid'] as string) : String(cursor.primaryKey)

        totalBytes += bytes
        itemCount += 1
        sinceLastPost += 1

        const bucket = buckets.get(contentType)
        if (bucket) {
          bucket.bytes += bytes
          bucket.count += 1
        } else {
          buckets.set(contentType, { contentType, bytes, count: 1 })
        }

        insertTopN(largest, { uuid, contentType, title: labelForEntry(value, uuid), bytes }, topN)

        if (sinceLastPost >= chunkSize) {
          sinceLastPost = 0
          post({
            type: 'progress',
            requestId,
            snapshot: buildSnapshot(totalBytes, itemCount, buckets, largest, false),
          })
        }

        cursor.continue()
      } else {
        post({ type: 'done', requestId, snapshot: buildSnapshot(totalBytes, itemCount, buckets, largest, true) })
        db.close()
      }
    }
  }
}

ctx.onmessage = (event: MessageEvent<StorageUsageWorkerRequest>): void => {
  const request = event.data
  if (request.type === 'scan') {
    try {
      scan(request)
    } catch (error) {
      post({
        type: 'error',
        requestId: request.requestId,
        message: error instanceof Error ? error.message : 'scan failed',
      })
    }
  }
}

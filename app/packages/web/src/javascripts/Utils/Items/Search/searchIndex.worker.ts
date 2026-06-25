// Web Worker that owns a SearchIndex instance off the main thread.
//
// Building the inverted index is O(n) over every decrypted note's title+text and
// can jank the UI on large accounts. Running it here keeps the main thread free:
// the page posts the searchable note text in, the worker builds/queries the index
// and posts results back. The query API/behavior is identical to the synchronous
// SearchIndex (this worker literally delegates to the same class) so search
// semantics never regress.
//
// The matching main-thread client is ThreadedSearchIndex.ts, which falls back to
// running SearchIndex inline when Workers are unavailable (tests/SSR).

import { SearchIndex } from './SearchIndex'
import { SearchIndexWorkerRequest, SearchIndexWorkerResponse } from './searchIndexWorkerProtocol'

const ctx = self as unknown as DedicatedWorkerGlobalScope

let index = new SearchIndex()

const post = (message: SearchIndexWorkerResponse): void => {
  ctx.postMessage(message)
}

ctx.onmessage = (event: MessageEvent<SearchIndexWorkerRequest>): void => {
  const request = event.data
  try {
    switch (request.type) {
      case 'configure': {
        // Recreate with the requested options (e.g. queryCacheSize). The next
        // rebuild repopulates it, so we don't lose correctness by discarding here.
        index = new SearchIndex(request.options)
        post({ type: 'configured', requestId: request.requestId })
        break
      }
      case 'rebuild': {
        index.rebuild(request.notes)
        post({ type: 'rebuilt', requestId: request.requestId, size: index.size, snapshot: index.toSnapshot() })
        break
      }
      case 'updateMany': {
        index.updateMany(request.changedOrInserted, request.removed)
        post({ type: 'updated', requestId: request.requestId, size: index.size, snapshot: index.toSnapshot() })
        break
      }
      case 'search': {
        const result = index.search(request.query, request.options)
        post({ type: 'searched', requestId: request.requestId, result })
        break
      }
      case 'flush': {
        index.flush()
        post({ type: 'flushed', requestId: request.requestId })
        break
      }
    }
  } catch (error) {
    post({
      type: 'error',
      requestId: request.requestId,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

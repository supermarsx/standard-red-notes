// Main-thread client that runs the heavy index BUILD off the UI thread.
//
// The synchronous SearchIndex (SearchIndex.ts) is unchanged and still owns the
// query path: ThreadedSearchIndex keeps a local SearchIndex instance that serves
// search()/isBuilt/size synchronously exactly as before. What moves to the worker
// is the expensive O(n) tokenization in rebuild()/updateMany(): we post the note
// text to searchIndex.worker.ts, it builds and returns a structured-clone
// snapshot, and we adopt it on the main thread via loadSnapshot() (cheap Map/Set
// rehydration, no re-tokenization). The UI never janks on a big rebuild.
//
// Fallback: when Workers are unavailable (jest/jsdom, SSR, or worker construction
// failure) we transparently build on the main thread — identical results, just
// without the offload. Gate is `typeof Worker !== 'undefined'`.

import { IndexableNote, SearchIndex, SearchIndexOptions, SearchQueryOptions } from './SearchIndex'
import { SearchIndexWorkerRequest, SearchIndexWorkerResponse } from './searchIndexWorkerProtocol'
// worker-loader rewrites this module into a Worker constructor at build time (see
// the `/\.worker\.tsx?$/` rule in web.webpack.config.js). Importing it as a
// namespace and casting to a Worker constructor — instead of `new Worker(new
// URL(..., import.meta.url))` — keeps ts-jest happy (its CommonJS module target
// rejects `import.meta`) while still giving webpack the worker. The constructor is
// only ever called when `typeof Worker !== 'undefined'`, so jest (jsdom has no
// Worker) never evaluates it and always takes the inline main-thread fallback.
import * as SearchIndexWorkerModule from './searchIndex.worker'

const SearchIndexWorker = SearchIndexWorkerModule as unknown as { new (): Worker }

type PendingResolver = (response: SearchIndexWorkerResponse) => void

/**
 * Omit that distributes over a union, so each member of the discriminated
 * SearchIndexWorkerRequest union keeps its own shape minus `requestId` (a plain
 * `Omit<Union, K>` would collapse to only the common keys).
 */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never

type SearchIndexWorkerRequestPayload = DistributiveOmit<SearchIndexWorkerRequest, 'requestId'>

export class ThreadedSearchIndex {
  /** Synchronous main-thread index that always serves queries (kept in sync). */
  private readonly local: SearchIndex
  private worker: Worker | null = null
  private nextRequestId = 1
  private readonly pending = new Map<number, PendingResolver>()
  private readonly options: SearchIndexOptions

  constructor(options: SearchIndexOptions = {}) {
    this.options = options
    this.local = new SearchIndex(options)
    this.tryStartWorker()
  }

  /** True when a real Web Worker is offloading builds; false for the inline fallback. */
  get isThreaded(): boolean {
    return this.worker !== null
  }

  get isBuilt(): boolean {
    return this.local.isBuilt
  }

  get size(): number {
    return this.local.size
  }

  private tryStartWorker(): void {
    if (typeof Worker === 'undefined') {
      return
    }
    try {
      this.worker = new SearchIndexWorker()
      this.worker.onmessage = (event: MessageEvent<SearchIndexWorkerResponse>) => {
        const resolver = this.pending.get(event.data.requestId)
        if (resolver) {
          this.pending.delete(event.data.requestId)
          resolver(event.data)
        }
      }
      this.worker.onerror = () => {
        // If the worker dies, fall back to main-thread building so search keeps working.
        this.teardownWorker()
      }
      void this.send({ type: 'configure', options: this.options })
    } catch {
      this.worker = null
    }
  }

  private teardownWorker(): void {
    if (this.worker) {
      this.worker.terminate()
      this.worker = null
    }
    // Reject nothing explicitly; callers race against the local fallback below.
    this.pending.clear()
  }

  private send(message: SearchIndexWorkerRequestPayload): Promise<SearchIndexWorkerResponse> {
    const worker = this.worker
    if (!worker) {
      return Promise.reject(new Error('worker unavailable'))
    }
    const requestId = this.nextRequestId++
    return new Promise<SearchIndexWorkerResponse>((resolve) => {
      this.pending.set(requestId, resolve)
      worker.postMessage({ ...message, requestId } as SearchIndexWorkerRequest)
    })
  }

  /**
   * (Re)build the whole index from the given notes. Off-thread when possible; the
   * resulting snapshot is adopted by the local index so subsequent search() calls
   * are synchronous and identical to the non-threaded path. Falls back to building
   * locally if the worker is missing or errors.
   */
  async rebuild(notes: IndexableNote[]): Promise<void> {
    if (!this.worker) {
      this.local.rebuild(notes)
      return
    }
    try {
      const response = await this.send({ type: 'rebuild', notes })
      if (response.type === 'rebuilt' && response.snapshot) {
        this.local.loadSnapshot(response.snapshot)
        return
      }
      // Unexpected/error response: fall back so we never leave the index unbuilt.
      this.local.rebuild(notes)
    } catch {
      this.teardownWorker()
      this.local.rebuild(notes)
    }
  }

  /** Ensure the index is built once; lazy/async build via the worker when needed. */
  async ensureBuilt(notesProvider: () => IndexableNote[]): Promise<void> {
    if (this.local.isBuilt) {
      return
    }
    await this.rebuild(notesProvider())
  }

  /**
   * Apply a coalesced batch of incremental changes. Mirrors SearchIndex.updateMany.
   * Applied to the local index immediately (incremental work is cheap and keeps
   * queries correct without a round-trip) and forwarded to the worker so its copy
   * stays in sync for the next full rebuild.
   */
  updateMany(changedOrInserted: IndexableNote[], removed: string[]): void {
    this.local.updateMany(changedOrInserted, removed)
    if (this.worker) {
      void this.send({ type: 'updateMany', changedOrInserted, removed }).catch(() => this.teardownWorker())
    }
  }

  /** Synchronous query — identical behavior/return contract to SearchIndex.search. */
  search(query: string, options: SearchQueryOptions = {}): string[] | null {
    return this.local.search(query, options)
  }

  /** Clear the index everywhere; the next ensureBuilt() rebuilds lazily. */
  flush(): void {
    this.local.flush()
    if (this.worker) {
      void this.send({ type: 'flush' }).catch(() => this.teardownWorker())
    }
  }

  refresh(): void {
    this.flush()
  }

  /** Release the worker. Call when the owning controller is torn down. */
  destroy(): void {
    this.teardownWorker()
  }
}

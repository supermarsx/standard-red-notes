// Main-thread manager for the off-main-thread decryption worker pool.
//
// Fans batches of payloads out across a pool of decryption workers, so
// cold-loading a large vault decrypts in parallel across CPU cores instead of
// blocking the main thread with one long synchronous WASM loop. Implements
// PayloadDecryptionPoolInterface, which ItemsEncryptionService calls when
// AVAILABLE + ENABLED, falling back to its sync path otherwise.
//
// Workers are spawned LAZILY up to a max. Each worker compiles its OWN libsodium
// WASM on first use, so eagerly spinning N workers on a 40-core box made SMALL
// vaults SLOWER (heavy per-worker init + structured-clone overhead dominated the
// tiny amount of real work). Instead we start with INITIAL_WORKERS and add a
// worker only when a decrypt call has more batches than live workers, capped at
// `maxWorkers`. A small vault that only queues a couple batches therefore never
// spins more than a couple workers (no 40x WASM init), while a big cold-load grows
// the pool all the way to the cap and uses every core.
//
// Worker construction MIRRORS ThreadedSearchIndex: worker-loader rewrites the
// `*.worker.ts` import into a Worker constructor at build time (see the
// `/\.worker\.tsx?$/` rule in web.webpack.config.js). We import it as a namespace
// and cast — instead of `new Worker(new URL(..., import.meta.url))` — so ts-jest
// (CommonJS target, no import.meta) stays happy. The constructor only runs when
// `typeof Worker !== 'undefined'`, so jest/jsdom (no Worker) never evaluates it.

import {
  DecryptedParameters,
  ErrorDecryptingParameters,
  ItemContent,
  PayloadDecryptionPoolInterface,
  PooledDecryptionJob,
} from '@standardnotes/snjs'
import { DecryptionWorkerRequest, DecryptionWorkerResponse } from './decryptionWorkerProtocol'
import * as DecryptionWorkerModule from './decryption.worker'

// worker-loader (esModule: true, the default) emits the Worker constructor as the
// module's DEFAULT export, so `import * as M` yields `{ default: Ctor }`. Casting
// the namespace object straight to a constructor — `M as { new(): Worker }` — makes
// `new M()` throw ("M is not a constructor"), which silently zeroed the pool. Pick
// `.default` when present, else fall back to the namespace (covers esModule: false).
const DecryptionWorker = ((DecryptionWorkerModule as { default?: { new (): Worker } }).default ??
  (DecryptionWorkerModule as unknown as { new (): Worker })) as { new (): Worker }

/**
 * Max payloads per postMessage batch, and the small/medium-load ramp granularity
 * (one worker spun per BATCH_SIZE jobs). Large enough to amortize the structured
 * clone + round-trip cost, small enough that batches spread evenly across workers
 * and the first results stream back quickly. We never send a bigger message than
 * this, so peak per-message clone size is bounded regardless of pool width.
 */
const BATCH_SIZE = 500

/**
 * Floor on the per-message slice when a big load is spread across many workers, so
 * saturating a high-core box doesn't degenerate into a flood of trivially small
 * postMessages (each still carries fixed per-round-trip overhead).
 */
const MIN_BATCH_SIZE = 64

/**
 * At/above this job count a decrypt call is treated as a bulk cold-load and is
 * fanned across EVERY available worker (up to maxWorkers), slicing finer than
 * BATCH_SIZE so no core sits idle. Below it we keep the original conservative
 * ramp (one worker per BATCH_SIZE jobs) so small/medium vaults never pay an
 * N-worker WASM-init stampede. Chosen comfortably above the couple-of-batches
 * small-load range and below the web cold-load batch size (loadBatchSize 5000).
 */
const SATURATE_THRESHOLD = 2000

/**
 * Workers spawned eagerly at construction. Kept tiny (a couple) so a small vault
 * pays at most a couple per-worker WASM inits; additional workers materialize only
 * when a real decrypt call demands more parallelism.
 */
const INITIAL_WORKERS = 2

type PendingResolver = (response: DecryptionWorkerResponse) => void

interface PoolWorker {
  worker: Worker
  pending: Map<number, PendingResolver>
}

/**
 * Configuration for the pool's worker ceiling. `maxWorkers` of 0 (or omitted)
 * selects the auto policy: hardwareConcurrency - 1. A positive value is clamped to
 * [1, hardwareConcurrency], letting the user dedicate the full thread count.
 */
export interface DecryptionPoolConfig {
  /** Pref-driven ceiling. 0 == auto (hardwareConcurrency - 1). */
  maxWorkers?: number
}

export class DecryptionPool implements PayloadDecryptionPoolInterface {
  private workers: PoolWorker[] = []
  private nextWorker = 0
  private nextRequestId = 1
  private destroyed = false
  private maxWorkers: number
  /** True once the (lazy) initial workers have been spawned. */
  private warmedUp = false

  /**
   * Runtime visibility into whether the pool is actually doing work or silently
   * falling back to the sync path (e.g. libsodium failing to init in the worker).
   * Exposed on globalThis.__srnDecryptPool so the stress harness can read it.
   * `spawned` is the count of live workers; `maxWorkers` the lazy-growth ceiling.
   */
  readonly stats = {
    workers: 0,
    spawned: 0,
    maxWorkers: 0,
    batchesOk: 0,
    batchesFailed: 0,
    workerErrors: 0,
    lastError: '',
  }

  constructor(config: DecryptionPoolConfig = {}) {
    this.maxWorkers = this.resolveMaxWorkers(config.maxWorkers)
    this.stats.maxWorkers = this.maxWorkers
    if (typeof globalThis !== 'undefined') {
      ;(globalThis as unknown as { __srnDecryptPool?: unknown }).__srnDecryptPool = this.stats
    }
    if (typeof Worker === 'undefined') {
      return
    }
    // Eagerly spawn only a tiny initial set; the rest grow on demand (see decrypt()).
    this.ensureWorkers(INITIAL_WORKERS)
    this.warmedUp = true
  }

  /**
   * Translate the configured ceiling into an absolute worker count.
   * - undefined / 0 -> auto: hardwareConcurrency - 1 (min 1).
   * - > 0           -> min(value, hardwareConcurrency) (the user may use every core).
   */
  private resolveMaxWorkers(configured?: number): number {
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined
    const hardware = Math.max(1, cores || 4)
    if (configured && configured > 0) {
      return Math.min(configured, hardware)
    }
    return Math.max(1, hardware - 1)
  }

  /**
   * Update the worker ceiling at runtime (e.g. when the pref loads after launch).
   * Never tears down existing workers; lowering the cap just stops further growth
   * and trims rotation down to the new ceiling. Raising it lets the next big batch
   * spawn more workers lazily.
   */
  setMaxWorkers(configured?: number): void {
    if (this.destroyed) {
      return
    }
    this.maxWorkers = this.resolveMaxWorkers(configured)
    this.stats.maxWorkers = this.maxWorkers
    if (this.workers.length > this.maxWorkers) {
      const surplus = this.workers.splice(this.maxWorkers)
      for (const entry of surplus) {
        this.dropWorker(entry, new Error('decryption pool max workers lowered'))
      }
      this.stats.spawned = this.workers.length
      this.stats.workers = this.workers.length
    }
  }

  /**
   * Lazily grow the pool toward `target`, never exceeding `maxWorkers`. Returns the
   * resulting live-worker count. A no-op when Workers are unavailable.
   */
  private ensureWorkers(target: number): number {
    if (typeof Worker === 'undefined' || this.destroyed) {
      return this.workers.length
    }
    const desired = Math.min(Math.max(target, 0), this.maxWorkers)
    while (this.workers.length < desired) {
      const created = this.tryCreateWorker()
      if (!created) {
        break
      }
      this.workers.push(created)
    }
    this.stats.spawned = this.workers.length
    this.stats.workers = this.workers.length
    return this.workers.length
  }

  /** True only when at least one real worker is alive (or can still be spawned). */
  get isAvailable(): boolean {
    if (this.destroyed || typeof Worker === 'undefined') {
      return false
    }
    // After warm-up a zero count means construction failed (no real worker ever
    // materialized); before warm-up the constructor handles it.
    return this.warmedUp ? this.workers.length > 0 : true
  }

  private tryCreateWorker(): PoolWorker | null {
    try {
      const worker = new DecryptionWorker()
      const entry: PoolWorker = { worker, pending: new Map() }
      worker.onmessage = (event: MessageEvent<DecryptionWorkerResponse>) => {
        const resolver = entry.pending.get(event.data.requestId)
        if (resolver) {
          entry.pending.delete(event.data.requestId)
          resolver(event.data)
        }
      }
      worker.onerror = () => {
        // A dead worker rejects its in-flight batches; the caller falls back to
        // the sync path for those, and we drop it from rotation.
        this.stats.workerErrors++
        this.dropWorker(entry, new Error('decryption worker errored'))
      }
      return entry
    } catch (error) {
      this.stats.lastError = error instanceof Error ? error.message : String(error)
      return null
    }
  }

  private dropWorker(entry: PoolWorker, error: Error): void {
    const index = this.workers.indexOf(entry)
    if (index !== -1) {
      this.workers.splice(index, 1)
    }
    for (const resolver of entry.pending.values()) {
      resolver({ type: 'error', requestId: -1, message: error.message })
    }
    entry.pending.clear()
    try {
      entry.worker.terminate()
    } catch {
      /* already gone */
    }
    this.stats.spawned = this.workers.length
    this.stats.workers = this.workers.length
  }

  private send(entry: PoolWorker, jobs: PooledDecryptionJob[]): Promise<DecryptionWorkerResponse> {
    const requestId = this.nextRequestId++
    return new Promise<DecryptionWorkerResponse>((resolve) => {
      entry.pending.set(requestId, resolve)
      const message: DecryptionWorkerRequest = { type: 'decryptBatch', requestId, jobs }
      entry.worker.postMessage(message)
    })
  }

  async decrypt<C extends ItemContent = ItemContent>(
    jobs: PooledDecryptionJob[],
  ): Promise<(DecryptedParameters<C> | ErrorDecryptingParameters)[]> {
    if (!this.isAvailable) {
      throw new Error('decryption pool unavailable')
    }
    if (jobs.length === 0) {
      return []
    }

    // Decide how wide to grow the pool BEFORE dispatch.
    //  - Bulk cold-load (>= SATURATE_THRESHOLD jobs): use every core up to
    //    maxWorkers, but never assign a worker fewer than MIN_BATCH_SIZE jobs.
    //  - Small/medium: original conservative ramp — one worker per BATCH_SIZE jobs
    //    — so a couple-batch load never spawns more than the initial workers.
    const workerTarget =
      jobs.length >= SATURATE_THRESHOLD
        ? Math.min(this.maxWorkers, Math.max(1, Math.ceil(jobs.length / MIN_BATCH_SIZE)))
        : Math.ceil(jobs.length / BATCH_SIZE)
    const workerCount = this.ensureWorkers(workerTarget)

    if (workerCount === 0) {
      throw new Error('decryption pool unavailable')
    }

    // Slice size: spread evenly across the live workers so none idles, capped at
    // BATCH_SIZE (never a bigger message/clone than the original path) and floored
    // at MIN_BATCH_SIZE. For small/medium loads perWorker >= BATCH_SIZE, so this
    // collapses to the original fixed BATCH_SIZE slicing — behavior is identical.
    const perWorker = Math.ceil(jobs.length / workerCount)
    const batchSize = Math.min(BATCH_SIZE, Math.max(MIN_BATCH_SIZE, perWorker))

    // Split into round-robin batches across the live workers.
    const batches: { start: number; jobs: PooledDecryptionJob[]; entry: PoolWorker }[] = []
    for (let start = 0; start < jobs.length; start += batchSize) {
      const slice = jobs.slice(start, start + batchSize)
      const entry = this.workers[this.nextWorker % this.workers.length]
      this.nextWorker++
      batches.push({ start, jobs: slice, entry })
    }

    const results: (DecryptedParameters<C> | ErrorDecryptingParameters)[] = new Array(jobs.length)

    await Promise.all(
      batches.map(async (batch) => {
        const response = await this.send(batch.entry, batch.jobs)
        if (response.type !== 'decrypted') {
          this.stats.batchesFailed++
          // Surface so the service-level fallback re-runs the whole call sync.
          throw new Error(response.message || 'decryption worker batch failed')
        }
        this.stats.batchesOk++
        for (let i = 0; i < response.results.length; i++) {
          results[batch.start + i] = response.results[i] as DecryptedParameters<C> | ErrorDecryptingParameters
        }
      }),
    )

    return results
  }

  destroy(): void {
    this.destroyed = true
    for (const entry of [...this.workers]) {
      this.dropWorker(entry, new Error('decryption pool destroyed'))
    }
    this.workers = []
    this.stats.spawned = 0
    this.stats.workers = 0
  }
}

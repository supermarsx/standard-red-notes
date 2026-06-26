// Main-thread manager for the off-main-thread decryption worker pool.
//
// Spins up N = max(1, hardwareConcurrency - 1) decryption workers and fans
// batches of payloads out across them, so cold-loading a large vault decrypts in
// parallel across CPU cores instead of blocking the main thread with one long
// synchronous WASM loop. Implements PayloadDecryptionPoolInterface, which
// ItemsEncryptionService calls when AVAILABLE + ENABLED, falling back to its sync
// path otherwise.
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

const DecryptionWorker = DecryptionWorkerModule as unknown as { new (): Worker }

/**
 * Max payloads per postMessage batch. Large enough to amortize the structured
 * clone + round-trip cost, small enough that batches spread evenly across workers
 * and the first results stream back quickly.
 */
const BATCH_SIZE = 500

type PendingResolver = (response: DecryptionWorkerResponse) => void

interface PoolWorker {
  worker: Worker
  pending: Map<number, PendingResolver>
}

export class DecryptionPool implements PayloadDecryptionPoolInterface {
  private workers: PoolWorker[] = []
  private nextWorker = 0
  private nextRequestId = 1
  private destroyed = false

  constructor() {
    if (typeof Worker === 'undefined') {
      return
    }
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined
    const count = Math.max(1, (cores || 4) - 1)
    for (let i = 0; i < count; i++) {
      const created = this.tryCreateWorker()
      if (created) {
        this.workers.push(created)
      }
    }
  }

  /** True only when at least one real worker is alive. */
  get isAvailable(): boolean {
    return !this.destroyed && this.workers.length > 0
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
        this.dropWorker(entry, new Error('decryption worker errored'))
      }
      return entry
    } catch {
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

    // Split into round-robin batches across the live workers.
    const batches: { start: number; jobs: PooledDecryptionJob[]; entry: PoolWorker }[] = []
    for (let start = 0; start < jobs.length; start += BATCH_SIZE) {
      const slice = jobs.slice(start, start + BATCH_SIZE)
      const entry = this.workers[this.nextWorker % this.workers.length]
      this.nextWorker++
      batches.push({ start, jobs: slice, entry })
    }

    const results: (DecryptedParameters<C> | ErrorDecryptingParameters)[] = new Array(jobs.length)

    await Promise.all(
      batches.map(async (batch) => {
        const response = await this.send(batch.entry, batch.jobs)
        if (response.type !== 'decrypted') {
          // Surface so the service-level fallback re-runs the whole call sync.
          throw new Error(response.message || 'decryption worker batch failed')
        }
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
  }
}

// Main-thread client that runs the Proof-of-Work solve off the UI thread.
//
// Scanning nonces for a digest with enough leading zero bits is pure CPU; at
// interactive difficulties it would jank the page. ThreadedPowSolver posts the
// challenge to powSolver.worker.ts and awaits the winning nonce, keeping the main
// thread free.
//
// Fallback: when Workers are unavailable (jest/jsdom, SSR, or worker construction
// failure) — or when a solve times out or the worker errors — we transparently
// solve on the main thread via solveProofOfWork. Identical result, just without
// the offload. Gate is `typeof Worker !== 'undefined'`.

import { solveProofOfWork } from './powSolver'
import { PowSolverWorkerRequest, PowSolverWorkerResponse } from './powSolverWorkerProtocol'
// worker-loader rewrites this module into a Worker constructor at build time (see
// the `/\.worker\.tsx?$/` rule in web.webpack.config.js). Importing it as a
// namespace and casting to a Worker constructor — instead of `new Worker(new
// URL(..., import.meta.url))` — keeps ts-jest happy (its CommonJS module target
// rejects `import.meta`) while still giving webpack the worker. The constructor is
// only ever called when `typeof Worker !== 'undefined'`, so jest (jsdom has no
// Worker) never evaluates it and always takes the inline main-thread fallback.
import * as PowSolverWorkerModule from './powSolver.worker'

// worker-loader (esModule: true, the default) emits the Worker constructor as the
// module's DEFAULT export, so `import * as M` yields `{ default: Ctor }`. Casting
// the namespace object straight to a constructor — `M as { new(): Worker }` — makes
// `new M()` throw ("M is not a constructor"), which silently disables the worker and
// pins every solve to the main-thread fallback. Pick `.default` when present, else
// fall back to the namespace (covers esModule: false). Mirrors ThreadedSearchIndex.
const PowSolverWorker = ((PowSolverWorkerModule as { default?: { new (): Worker } }).default ??
  (PowSolverWorkerModule as unknown as { new (): Worker })) as { new (): Worker }

/**
 * Per-request response deadline. A worker that HANGS mid-solve never fires onerror,
 * so without this solve() would await forever. On expiry we tear the worker down and
 * complete the solve synchronously on the main thread — the caller always gets a nonce.
 */
const REQUEST_TIMEOUT_MS = 30_000

export class ThreadedPowSolver {
  private worker: Worker | null = null
  private nextRequestId = 1
  private destroyed = false

  constructor() {
    this.tryStartWorker()
  }

  /** True when a real Web Worker is offloading solves; false for the inline fallback. */
  get isThreaded(): boolean {
    return this.worker !== null
  }

  private tryStartWorker(): void {
    if (typeof Worker === 'undefined' || this.destroyed) {
      return
    }
    try {
      this.worker = new PowSolverWorker()
    } catch {
      this.worker = null
    }
  }

  private teardownWorker(): void {
    if (this.worker) {
      this.worker.terminate()
      this.worker = null
    }
  }

  /**
   * Solve the challenge and resolve the winning nonce. Off-thread when a Worker is
   * available; otherwise (or on timeout/worker error) solved synchronously on the
   * main thread. Always resolves a nonce or rejects if the challenge itself is
   * invalid (e.g. difficulty over the safety cap), never hangs.
   */
  async solve(seed: string, difficulty: number): Promise<string> {
    const worker = this.worker
    if (!worker) {
      return solveProofOfWork(seed, difficulty)
    }

    const requestId = this.nextRequestId++
    try {
      return await new Promise<string>((resolve, reject) => {
        // Bounded wait: a hung worker never posts back, so without this solve() would
        // await forever. On expiry, tear the worker down and reject so we fall back to
        // the synchronous solve below.
        const timer = setTimeout(() => {
          this.teardownWorker()
          reject(new Error('proof-of-work worker timed out'))
        }, REQUEST_TIMEOUT_MS)

        worker.onmessage = (event: MessageEvent<PowSolverWorkerResponse>) => {
          const response = event.data
          if (response.requestId !== requestId) {
            return
          }
          clearTimeout(timer)
          if (response.type === 'solved') {
            resolve(response.nonce)
          } else {
            reject(new Error(response.message))
          }
        }
        worker.onerror = () => {
          clearTimeout(timer)
          this.teardownWorker()
          reject(new Error('proof-of-work worker errored'))
        }

        worker.postMessage({ type: 'solve', requestId, seed, difficulty } as PowSolverWorkerRequest)
      })
    } catch {
      // Worker timed out or errored: complete the solve on the main thread so the
      // caller still gets a nonce.
      return solveProofOfWork(seed, difficulty)
    }
  }

  /** Release the worker. Call when the owner is torn down. */
  destroy(): void {
    this.destroyed = true
    this.teardownWorker()
  }
}

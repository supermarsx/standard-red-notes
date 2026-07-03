// Web Worker that solves a Proof-of-Work challenge off the main thread.
//
// Scanning nonces until a SHA-256 digest has enough leading zero bits is a tight
// CPU loop that would jank the UI at interactive difficulties. Running it here
// keeps the main thread free: the page posts the seed+difficulty in, the worker
// solves and posts the winning nonce back. The solve is identical to the
// synchronous solveProofOfWork (this worker literally delegates to it) so results
// never diverge from the inline fallback.
//
// The matching main-thread client is ThreadedPowSolver.ts, which falls back to
// running solveProofOfWork inline when Workers are unavailable (tests/SSR).

import { solveProofOfWork } from './powSolver'
import { PowSolverWorkerRequest, PowSolverWorkerResponse } from './powSolverWorkerProtocol'

const ctx = self as unknown as DedicatedWorkerGlobalScope

const post = (message: PowSolverWorkerResponse): void => {
  ctx.postMessage(message)
}

ctx.onmessage = (event: MessageEvent<PowSolverWorkerRequest>): void => {
  const request = event.data
  try {
    switch (request.type) {
      case 'solve': {
        const nonce = solveProofOfWork(request.seed, request.difficulty)
        post({ type: 'solved', requestId: request.requestId, nonce })
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

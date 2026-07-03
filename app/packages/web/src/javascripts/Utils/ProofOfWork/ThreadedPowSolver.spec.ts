// Tests for ThreadedPowSolver: it must solve a Proof-of-Work challenge on the main
// thread when no Worker is available (jsdom default), and delegate to a real Worker
// when one is present. worker-loader emits the Worker constructor as the module's
// DEFAULT export, so the mock is returned as `{ __esModule: true, default: Ctor }` —
// the real shape. ThreadedPowSolver must unwrap `.default` to construct it; the
// "offloads to a real worker" test below fails if it casts the namespace directly.

// The fake worker is defined INSIDE the mock factory (jest hoists jest.mock above the
// imports, so a top-level class wouldn't exist yet when the factory runs). It answers
// a 'solve' request with a canned nonce so the delegation test can prove the request
// was routed through the worker rather than solved inline.
jest.mock('./powSolver.worker', () => {
  class MockPowSolverWorker {
    public onmessage: ((event: { data: unknown }) => void) | null = null
    public onerror: (() => void) | null = null

    postMessage(message: { type: string; requestId: number }): void {
      setTimeout(
        () => this.onmessage?.({ data: { type: 'solved', requestId: message.requestId, nonce: 'worker-solved' } }),
        0,
      )
    }

    terminate(): void {
      /* no-op */
    }
  }

  return { __esModule: true, default: MockPowSolverWorker }
})

import { sha256Bytes, hashMeetsDifficulty as directHashMeetsDifficulty, solveProofOfWork } from './powSolver'

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

describe('powSolver', () => {
  it('computes a correct SHA-256 (known "abc" test vector)', () => {
    expect(toHex(sha256Bytes(Uint8Array.from([0x61, 0x62, 0x63])))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('computes a correct SHA-256 for the empty input', () => {
    expect(toHex(sha256Bytes(new Uint8Array(0)))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('solveProofOfWork returns a nonce that meets the difficulty', () => {
    const seed = 'pure-seed'
    const nonce = solveProofOfWork(seed, 10)
    expect(directHashMeetsDifficulty(seed, nonce, 10)).toBe(true)
  })

  it('rejects a difficulty above the safety cap', () => {
    expect(() => solveProofOfWork('seed', 33)).toThrow()
  })
})

describe('ThreadedPowSolver', () => {
  let ThreadedPowSolver: typeof import('./ThreadedPowSolver').ThreadedPowSolver
  let hashMeetsDifficulty: typeof import('./powSolver').hashMeetsDifficulty
  const originalWorker = (global as { Worker?: unknown }).Worker

  const loadModules = () => {
    jest.isolateModules(() => {
      ThreadedPowSolver = require('./ThreadedPowSolver').ThreadedPowSolver
      hashMeetsDifficulty = require('./powSolver').hashMeetsDifficulty
    })
  }

  afterEach(() => {
    if (originalWorker === undefined) {
      delete (global as { Worker?: unknown }).Worker
    } else {
      ;(global as { Worker?: unknown }).Worker = originalWorker
    }
  })

  it('solves inline on the main thread when no Worker is available', async () => {
    delete (global as { Worker?: unknown }).Worker
    loadModules()

    const solver = new ThreadedPowSolver()
    expect(solver.isThreaded).toBe(false)

    const seed = 'inline-seed'
    const nonce = await solver.solve(seed, 8)

    expect(typeof nonce).toBe('string')
    expect(hashMeetsDifficulty(seed, nonce, 8)).toBe(true)
    solver.destroy()
  })

  it('offloads to a real worker when one is available (unwraps the .default constructor)', async () => {
    // typeof Worker !== 'undefined' gates the worker path; the actual constructor used
    // is the mocked module, not this stub.
    ;(global as { Worker?: unknown }).Worker = function () {} as unknown
    loadModules()

    const solver = new ThreadedPowSolver()
    expect(solver.isThreaded).toBe(true)

    // The mock worker answers with 'worker-solved', so getting it back proves the solve
    // was delegated to the worker (via the unwrapped `.default` ctor), not run inline.
    const nonce = await solver.solve('any-seed', 8)
    expect(nonce).toBe('worker-solved')
    solver.destroy()
  })
})

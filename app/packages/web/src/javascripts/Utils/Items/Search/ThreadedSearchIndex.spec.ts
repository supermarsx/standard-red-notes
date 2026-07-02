// Hardening tests for ThreadedSearchIndex: a HUNG search-index worker (one that
// accepts a rebuild but never posts back, and never fires onerror) must never leave
// rebuild() awaiting forever. The threaded index must time the worker out, settle the
// in-flight send, and transparently build on the main thread instead — so search keeps
// working and the UI never freezes. jsdom has no real Worker, so we install a
// controllable fake and drive the timeout with fake timers.

// The fake worker is defined INSIDE the mock factory (jest hoists jest.mock above the
// imports, so a top-level class wouldn't exist yet when the factory runs). It responds
// to `configure` so the worker stays "alive", but HANGS on `rebuild` when the global
// flag is set — exactly the freeze scenario. worker-loader emits the Worker constructor
// as the module's DEFAULT export, so we return it as `{ __esModule: true, default: Ctor }`
// — the real shape. ThreadedSearchIndex must unwrap `.default` to construct it; the
// "offloads to a real worker" test below fails if it casts the namespace directly.
jest.mock('./searchIndex.worker', () => {
  class MockSearchIndexWorker {
    public onmessage: ((event: { data: unknown }) => void) | null = null
    public onerror: (() => void) | null = null

    postMessage(message: { type: string; requestId: number }): void {
      const respond = (data: Record<string, unknown>) =>
        setTimeout(() => this.onmessage?.({ data: { requestId: message.requestId, ...data } }), 0)

      if (message.type === 'configure') {
        respond({ type: 'configured' })
        return
      }
      if (message.type === 'rebuild') {
        if ((globalThis as { __hangRebuild?: boolean }).__hangRebuild) {
          // Hang: accept the batch, never respond, never error.
          return
        }
        respond({ type: 'rebuilt', size: 0, snapshot: null })
        return
      }
      // updateMany / flush: ack with the matching "*ed" response.
      respond({ type: `${message.type}ed` })
    }

    terminate(): void {
      /* no-op */
    }
  }

  return { __esModule: true, default: MockSearchIndexWorker }
})

describe('ThreadedSearchIndex hung-worker hardening', () => {
  let ThreadedSearchIndex: typeof import('./ThreadedSearchIndex').ThreadedSearchIndex
  const originalWorker = (global as { Worker?: unknown }).Worker

  beforeEach(() => {
    ;(globalThis as { __hangRebuild?: boolean }).__hangRebuild = false
    // typeof Worker !== 'undefined' gates the worker path; the actual constructor used
    // is the mocked module, not this stub.
    ;(global as { Worker?: unknown }).Worker = function () {} as unknown
    jest.isolateModules(() => {
      ThreadedSearchIndex = require('./ThreadedSearchIndex').ThreadedSearchIndex
    })
  })

  afterEach(() => {
    ;(globalThis as { __hangRebuild?: boolean }).__hangRebuild = false
    if (originalWorker === undefined) {
      delete (global as { Worker?: unknown }).Worker
    } else {
      ;(global as { Worker?: unknown }).Worker = originalWorker
    }
  })

  it('offloads to a real worker when one is available', () => {
    const index = new ThreadedSearchIndex()
    expect(index.isThreaded).toBe(true)
    index.destroy()
  })

  it('times out a hung rebuild and completes it on the main thread instead of hanging', async () => {
    jest.useFakeTimers()
    try {
      ;(globalThis as { __hangRebuild?: boolean }).__hangRebuild = true
      const index = new ThreadedSearchIndex()
      // Let the configure round-trip settle so the worker is considered live.
      await jest.advanceTimersByTimeAsync(1)
      expect(index.isThreaded).toBe(true)

      const notes = [
        { uuid: 'a', title: 'Hello', text: 'world alpha' },
        { uuid: 'b', title: 'Beta', text: 'gamma delta' },
      ]
      const rebuildPromise = index.rebuild(notes)
      // Drive past the per-request deadline: the send times out, the worker is torn
      // down, and rebuild() falls back to the synchronous local build.
      await jest.advanceTimersByTimeAsync(31_000)
      await rebuildPromise

      // The batch was NOT lost: the index built locally and serves queries.
      expect(index.isBuilt).toBe(true)
      expect(index.size).toBe(2)
      index.destroy()
    } finally {
      jest.useRealTimers()
    }
  })

  it('keeps building after teardown via the local index (never hangs)', async () => {
    jest.useFakeTimers()
    try {
      ;(globalThis as { __hangRebuild?: boolean }).__hangRebuild = true
      const index = new ThreadedSearchIndex()
      await jest.advanceTimersByTimeAsync(1)

      const first = index.rebuild([{ uuid: 'a', title: 'A', text: 'one two' }])
      await jest.advanceTimersByTimeAsync(31_000)
      await first
      expect(index.isBuilt).toBe(true)
      expect(index.size).toBe(1)

      index.destroy()
    } finally {
      jest.useRealTimers()
    }
  })
})

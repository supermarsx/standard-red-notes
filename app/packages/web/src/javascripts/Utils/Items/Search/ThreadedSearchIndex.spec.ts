import { SearchIndex } from './SearchIndex'
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
    public messages: Array<{ type: string; requestId: number }> = []
    constructor() {
      const globals = globalThis as { __searchWorkers?: MockSearchIndexWorker[] }
      ;(globals.__searchWorkers ??= []).push(this)
    }

    postMessage(message: { type: string; requestId: number }): void {
      this.messages.push(message)
      const globals = globalThis as { __throwSearchPost?: string }
      if (globals.__throwSearchPost === message.type) {
        globals.__throwSearchPost = undefined
        throw new Error('postMessage failed')
      }
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
        // Emit a progress heartbeat BEFORE the terminal 'rebuilt' so tests can assert
        // that progress is surfaced without prematurely settling the request.
        respond({ type: 'progress', processed: 1, total: 2 })
        respond({ type: 'rebuilt', size: 0, snapshot: null })
        return
      }
      // updateMany / flush: ack with the matching "*ed" response.
      respond({ type: `${message.type}ed` })
    }

    terminate(): void {
      ;(globalThis as { __terminateCount?: number }).__terminateCount =
        ((globalThis as { __terminateCount?: number }).__terminateCount ?? 0) + 1
    }
  }

  return { __esModule: true, default: MockSearchIndexWorker }
})

describe('ThreadedSearchIndex hung-worker hardening', () => {
  let ThreadedSearchIndex: typeof import('./ThreadedSearchIndex').ThreadedSearchIndex
  const originalWorker = (global as { Worker?: unknown }).Worker

  beforeEach(() => {
    ;(globalThis as { __hangRebuild?: boolean }).__hangRebuild = false
    ;(globalThis as { __terminateCount?: number }).__terminateCount = 0
    ;(globalThis as { __searchWorkers?: unknown[] }).__searchWorkers = []
    ;(globalThis as { __throwSearchPost?: string }).__throwSearchPost = undefined
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

  it('killWorker terminates the worker, clears its reference, and does NOT auto-restart', async () => {
    jest.useFakeTimers()
    try {
      const index = new ThreadedSearchIndex()
      await jest.advanceTimersByTimeAsync(1)
      expect(index.isThreaded).toBe(true)
      const terminatesBefore = (globalThis as { __terminateCount?: number }).__terminateCount ?? 0

      index.killWorker()

      expect(index.isKilled).toBe(true)
      expect(index.isThreaded).toBe(false)
      expect((globalThis as { __terminateCount?: number }).__terminateCount).toBe(terminatesBefore + 1)

      // Give any (unwanted) restart backoff a chance to fire — it must NOT re-spawn.
      await jest.advanceTimersByTimeAsync(10_000)
      expect(index.isThreaded).toBe(false)

      index.destroy()
    } finally {
      jest.useRealTimers()
    }
  })

  it('restartWorker re-spawns a single fresh worker after a kill (no leak / no double-worker)', async () => {
    jest.useFakeTimers()
    try {
      const index = new ThreadedSearchIndex()
      await jest.advanceTimersByTimeAsync(1)
      index.killWorker()
      expect(index.isThreaded).toBe(false)

      index.restartWorker()
      await jest.advanceTimersByTimeAsync(1)

      expect(index.isKilled).toBe(false)
      expect(index.isThreaded).toBe(true)

      // Idempotent: a second restart while already live must not spawn a second worker.
      const terminatesBefore = (globalThis as { __terminateCount?: number }).__terminateCount ?? 0
      index.restartWorker()
      index.destroy()
      // destroy() terminates exactly the one live worker (no orphaned second one).
      expect((globalThis as { __terminateCount?: number }).__terminateCount).toBe(terminatesBefore + 1)
    } finally {
      jest.useRealTimers()
    }
  })

  it('surfaces rebuild progress heartbeats without settling the rebuild request', async () => {
    jest.useFakeTimers()
    try {
      const index = new ThreadedSearchIndex()
      await jest.advanceTimersByTimeAsync(1)

      const progress: Array<{ processed: number; total: number }> = []
      index.setProgressListener((p) => progress.push(p))

      const rebuildPromise = index.rebuild([
        { uuid: 'a', title: 'A', text: 'one two' },
        { uuid: 'b', title: 'B', text: 'three four' },
      ])
      await jest.advanceTimersByTimeAsync(1)
      await rebuildPromise

      // The progress heartbeat came through AND the rebuild still resolved normally.
      expect(progress).toContainEqual({ processed: 1, total: 2 })
      index.destroy()
    } finally {
      jest.useRealTimers()
    }
  })
  const workers = () =>
    (
      globalThis as unknown as {
        __searchWorkers: Array<{
          messages: Array<{ type: string; requestId: number }>
          onmessage: ((event: { data: unknown }) => void) | null
          onerror: (() => void) | null
        }>
      }
    ).__searchWorkers
  const reply = (
    worker: ReturnType<typeof workers>[number],
    notes: Array<{ uuid: string; title: string; text: string }>,
  ) => {
    const local = new SearchIndex()
    local.rebuild(notes)
    const request = worker.messages.filter((message) => message.type === 'rebuild').at(-1)!
    worker.onmessage?.({
      data: { requestId: request.requestId, type: 'rebuilt', size: notes.length, snapshot: local.toSnapshot() },
    })
  }

  it('replays edits and removals that arrive while a worker rebuild is pending', async () => {
    jest.useFakeTimers()
    try {
      ;(globalThis as { __hangRebuild?: boolean }).__hangRebuild = true
      const index = new ThreadedSearchIndex()
      await jest.advanceTimersByTimeAsync(1)
      const original = [
        { uuid: 'a', title: 'obsolete', text: '' },
        { uuid: 'b', title: 'removed', text: '' },
      ]
      const pending = index.rebuild(original)
      index.updateMany([{ uuid: 'a', title: 'latest', text: '' }], ['b'])
      reply(workers()[0], original)
      await pending
      expect(index.search('latest')).toEqual(['a'])
      expect(index.search('obsolete')).toEqual([])
      expect(index.search('removed')).toEqual([])
      index.destroy()
    } finally {
      jest.useRealTimers()
    }
  })

  it.each(['flush', 'killWorker', 'destroy'] as const)(
    'does not refill the index from a pending rebuild after %s',
    async (boundary) => {
      jest.useFakeTimers()
      try {
        ;(globalThis as { __hangRebuild?: boolean }).__hangRebuild = true
        const index = new ThreadedSearchIndex()
        await jest.advanceTimersByTimeAsync(1)
        const notes = [{ uuid: 'a', title: 'old private note', text: '' }]
        const pending = index.rebuild(notes)
        index[boundary]()
        if (boundary === 'flush') reply(workers()[0], notes)
        await pending
        expect(index.isBuilt).toBe(false)
        expect(index.size).toBe(0)
        index.destroy()
      } finally {
        jest.useRealTimers()
      }
    },
  )

  it('keeps the newer rebuild when an older snapshot arrives last', async () => {
    jest.useFakeTimers()
    try {
      ;(globalThis as { __hangRebuild?: boolean }).__hangRebuild = true
      const index = new ThreadedSearchIndex()
      await jest.advanceTimersByTimeAsync(1)
      const old = [{ uuid: 'old', title: 'obsolete', text: '' }]
      const first = index.rebuild(old)
      const firstRequest = workers()[0]
        .messages.filter((message) => message.type === 'rebuild')
        .at(-1)!
      const second = index.rebuild([{ uuid: 'new', title: 'current', text: '' }])
      reply(workers()[0], [{ uuid: 'new', title: 'current', text: '' }])
      await second
      const oldIndex = new SearchIndex()
      oldIndex.rebuild(old)
      workers()[0].onmessage?.({
        data: { requestId: firstRequest.requestId, type: 'rebuilt', size: 1, snapshot: oldIndex.toSnapshot() },
      })
      await first
      expect(index.search('current')).toEqual(['new'])
      expect(index.search('obsolete')).toEqual([])
      index.destroy()
    } finally {
      jest.useRealTimers()
    }
  })

  it('does not let a late queued error from an old worker tear down its replacement', async () => {
    jest.useFakeTimers()
    try {
      ;(globalThis as { __hangRebuild?: boolean }).__hangRebuild = true
      const index = new ThreadedSearchIndex()
      await jest.advanceTimersByTimeAsync(1)
      const pending = index.rebuild([{ uuid: 'old', title: 'obsolete', text: '' }])
      const staleError = workers()[0].onerror!
      index.killWorker()
      index.restartWorker()
      staleError()
      await pending
      await jest.advanceTimersByTimeAsync(1)
      expect(index.isThreaded).toBe(true)
      expect(index.isBuilt).toBe(false)
      expect((globalThis as { __terminateCount?: number }).__terminateCount).toBe(1)
      index.destroy()
    } finally {
      jest.useRealTimers()
    }
  })

  it('replays changes into the local fallback when the worker fails a pending rebuild', async () => {
    jest.useFakeTimers()
    try {
      ;(globalThis as { __hangRebuild?: boolean }).__hangRebuild = true
      const index = new ThreadedSearchIndex()
      await jest.advanceTimersByTimeAsync(1)
      const pending = index.rebuild([{ uuid: 'a', title: 'obsolete', text: '' }])
      index.updateMany([{ uuid: 'a', title: 'changed', text: '' }], [])
      workers()[0].onerror?.()
      await pending
      expect(index.search('changed')).toEqual(['a'])
      expect(index.search('obsolete')).toEqual([])
      index.destroy()
    } finally {
      jest.useRealTimers()
    }
  })
  it('handles a configure postMessage failure without killing a newer worker or leaving a deadline', async () => {
    jest.useFakeTimers()
    try {
      ;(globalThis as { __throwSearchPost?: string }).__throwSearchPost = 'configure'
      const index = new ThreadedSearchIndex()
      index.killWorker()
      index.restartWorker()
      await jest.advanceTimersByTimeAsync(31000)
      expect(index.isThreaded).toBe(true)
      expect(workers()).toHaveLength(2)
      expect((globalThis as { __terminateCount?: number }).__terminateCount).toBe(1)
      index.destroy()
    } finally {
      jest.useRealTimers()
    }
  })
})

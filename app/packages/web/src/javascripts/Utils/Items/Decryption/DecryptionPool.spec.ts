// Lazy-spawn policy tests for the off-main-thread decryption worker pool.
//
// Each pool worker compiles its OWN libsodium WASM on first use, so the pool must
// spawn workers LAZILY: a small decrypt (a batch or two) must spin only the tiny
// initial set (no 40x WASM init), while a big cold-load grows the pool up to the
// configured/auto max so every core is used. These tests assert that growth policy
// against a fake Worker (jsdom has no real Worker), without touching real crypto.

// A controllable fake Worker. Each instance echoes back a `decrypted` response for
// every batch it receives, so decrypt() resolves and we can count how many distinct
// workers were ever constructed.
let constructedWorkers = 0

class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null

  constructor() {
    constructedWorkers++
  }

  postMessage(message: { type: string; requestId: number; jobs: unknown[] }): void {
    // Respond asynchronously, mirroring a real worker round-trip.
    setTimeout(() => {
      this.onmessage?.({
        data: {
          type: 'decrypted',
          requestId: message.requestId,
          results: message.jobs.map(() => ({ uuid: 'x' })),
        },
      })
    }, 0)
  }

  terminate(): void {
    /* no-op */
  }
}

// worker-loader emits the Worker constructor as the module default export; the pool
// reads `.default ?? namespace`. Mirror that so the interop fix stays exercised.
jest.mock('./decryption.worker', () => ({ __esModule: true, default: FakeWorker }))

// BATCH_SIZE inside the pool — one batch per 500 jobs.
const BATCH_SIZE = 500

const makeJobs = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    encrypted: { uuid: String(i) },
    itemsKey: 'deadbeef',
  })) as never[]

describe('DecryptionPool lazy spawn', () => {
  let DecryptionPool: typeof import('./DecryptionPool').DecryptionPool
  const originalWorker = (global as { Worker?: unknown }).Worker
  const originalConcurrency = Object.getOwnPropertyDescriptor(navigator, 'hardwareConcurrency')

  beforeEach(() => {
    constructedWorkers = 0
    ;(global as { Worker?: unknown }).Worker = FakeWorker as unknown
    // Plenty of cores so the max ceiling is large and growth is observable.
    Object.defineProperty(navigator, 'hardwareConcurrency', { value: 40, configurable: true })
    jest.isolateModules(() => {
      DecryptionPool = require('./DecryptionPool').DecryptionPool
    })
  })

  afterEach(() => {
    if (originalWorker === undefined) {
      delete (global as { Worker?: unknown }).Worker
    } else {
      ;(global as { Worker?: unknown }).Worker = originalWorker
    }
    if (originalConcurrency) {
      Object.defineProperty(navigator, 'hardwareConcurrency', originalConcurrency)
    }
  })

  it('only spawns the small initial set at construction', () => {
    const pool = new DecryptionPool()
    // INITIAL_WORKERS is 2 — no eager 39-worker WASM stampede.
    expect(constructedWorkers).toBe(2)
    expect(pool.stats.spawned).toBe(2)
    pool.destroy()
  })

  it('keeps a small job count to a few workers (no N×WASM init)', async () => {
    const pool = new DecryptionPool()
    // 2 batches worth of jobs -> needs at most 2 workers.
    await pool.decrypt(makeJobs(BATCH_SIZE * 2))
    expect(constructedWorkers).toBeLessThanOrEqual(2)
    expect(pool.stats.spawned).toBeLessThanOrEqual(2)
    expect(pool.stats.batchesOk).toBe(2)
    pool.destroy()
  })

  it('grows up to the auto max (hardwareConcurrency - 1) for a large job count', async () => {
    const pool = new DecryptionPool()
    expect(pool.stats.maxWorkers).toBe(39)
    // 100 batches worth of jobs, but growth is capped at maxWorkers (39).
    await pool.decrypt(makeJobs(BATCH_SIZE * 100))
    expect(pool.stats.spawned).toBe(39)
    expect(constructedWorkers).toBe(39)
    pool.destroy()
  })

  it('fans a mid-size bulk load across all cores, not just ceil(jobs / BATCH_SIZE) workers', async () => {
    const pool = new DecryptionPool()
    // 5000 jobs = only 10 BATCH_SIZE batches, but it is a bulk cold-load batch:
    // it must saturate up to maxWorkers (39) rather than idle 29 cores.
    const results = await pool.decrypt(makeJobs(5000))
    expect(results).toHaveLength(5000)
    expect(pool.stats.spawned).toBe(39)
    expect(constructedWorkers).toBe(39)
    // No item is lost and every batch succeeded.
    expect(pool.stats.batchesFailed).toBe(0)
    expect(pool.stats.batchesOk).toBeGreaterThanOrEqual(39)
    pool.destroy()
  })

  it('respects an explicit maxWorkers ceiling, clamped to hardwareConcurrency', async () => {
    const pool = new DecryptionPool({ maxWorkers: 4 })
    expect(pool.stats.maxWorkers).toBe(4)
    await pool.decrypt(makeJobs(BATCH_SIZE * 100))
    expect(pool.stats.spawned).toBe(4)
    expect(constructedWorkers).toBe(4)
    pool.destroy()
  })

  it('clamps an over-large explicit maxWorkers to hardwareConcurrency (full thread count)', () => {
    const pool = new DecryptionPool({ maxWorkers: 1000 })
    expect(pool.stats.maxWorkers).toBe(40)
    pool.destroy()
  })

  it('setMaxWorkers lowers the ceiling and trims surplus workers', async () => {
    const pool = new DecryptionPool()
    await pool.decrypt(makeJobs(BATCH_SIZE * 100))
    expect(pool.stats.spawned).toBe(39)
    pool.setMaxWorkers(3)
    expect(pool.stats.maxWorkers).toBe(3)
    expect(pool.stats.spawned).toBe(3)
    pool.destroy()
  })
})

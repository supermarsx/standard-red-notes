// Hardening tests for the storage-usage manager's main-thread liveness watchdog. If
// the worker wedges before posting anything (or a message is lost), the Storage pane
// must NOT be stuck loading forever: the manager surfaces an error and tears the worker
// down so the pane leaves its loading state. jsdom has no real Worker, so we install a
// controllable fake whose messages the test drives by hand.

// Defined inside the factory (jest.mock is hoisted above imports). Instances are pushed
// to a global array so the test can reach each worker's onmessage/onerror and terminate
// flag. The manager reads `.default ?? namespace`, so we export it as `.default`.
jest.mock('./storageUsage.worker', () => {
  const instances: unknown[] = []
  ;(globalThis as { __mockStorageWorkers?: unknown[] }).__mockStorageWorkers = instances

  class MockStorageWorker {
    public onmessage: ((event: { data: unknown }) => void) | null = null
    public onerror: (() => void) | null = null
    public terminated = false

    constructor() {
      instances.push(this)
    }

    postMessage(): void {
      /* The test drives responses via instance.onmessage; nothing auto-posts. */
    }

    terminate(): void {
      this.terminated = true
    }
  }

  return { __esModule: true, default: MockStorageWorker }
})

import { scanStorageUsage } from './StorageUsageManager'
import { StorageUsageSnapshot } from './storageUsageWorkerProtocol'

type MockWorker = {
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: (() => void) | null
  terminated: boolean
}

const workers = (): MockWorker[] =>
  ((globalThis as { __mockStorageWorkers?: MockWorker[] }).__mockStorageWorkers ?? []) as MockWorker[]

const emptySnapshot = (done: boolean): StorageUsageSnapshot => ({
  totalBytes: 0,
  itemCount: 0,
  buckets: [],
  sources: [],
  largest: [],
  done,
})

describe('StorageUsageManager liveness watchdog', () => {
  const originalWorker = (global as { Worker?: unknown }).Worker
  const originalIndexedDB = (global as { indexedDB?: unknown }).indexedDB

  beforeEach(() => {
    // Truncate the factory's instance array IN PLACE (reassigning would leave the mock
    // pushing into the old array while the test reads a fresh, empty one).
    workers().length = 0
    ;(global as { Worker?: unknown }).Worker = function () {} as unknown
    ;(global as { indexedDB?: unknown }).indexedDB = {} as unknown
  })

  afterEach(() => {
    jest.useRealTimers()
    if (originalWorker === undefined) {
      delete (global as { Worker?: unknown }).Worker
    } else {
      ;(global as { Worker?: unknown }).Worker = originalWorker
    }
    if (originalIndexedDB === undefined) {
      delete (global as { indexedDB?: unknown }).indexedDB
    } else {
      ;(global as { indexedDB?: unknown }).indexedDB = originalIndexedDB
    }
  })

  it('surfaces an error and terminates a fully silent worker instead of loading forever', () => {
    jest.useFakeTimers()
    const onSnapshot = jest.fn()
    const onError = jest.fn()

    const handle = scanStorageUsage('workspace-db', { onSnapshot, onError })
    expect(handle).not.toBeNull()
    const worker = workers()[0]

    // The worker never posts. After the idle deadline the watchdog fires.
    jest.advanceTimersByTime(150_000)

    expect(onError).toHaveBeenCalledWith('Storage scan timed out')
    expect(worker.terminated).toBe(true)
    expect(onSnapshot).not.toHaveBeenCalled()
  })

  it('resets the idle deadline on each message so a progressing scan is not aborted', () => {
    jest.useFakeTimers()
    const onSnapshot = jest.fn()
    const onError = jest.fn()

    scanStorageUsage('workspace-db', { onSnapshot, onError })
    const worker = workers()[0]

    // Progress arrives just before the first deadline, resetting the watchdog.
    jest.advanceTimersByTime(149_000)
    worker.onmessage?.({ data: { type: 'progress', requestId: 1, snapshot: emptySnapshot(false) } })
    expect(onSnapshot).toHaveBeenCalledTimes(1)

    // 149s more would have tripped the ORIGINAL deadline; the reset means no error yet.
    jest.advanceTimersByTime(149_000)
    expect(onError).not.toHaveBeenCalled()

    // Past the reset deadline with continued silence: now it fires.
    jest.advanceTimersByTime(2_000)
    expect(onError).toHaveBeenCalledWith('Storage scan timed out')
    expect(worker.terminated).toBe(true)
  })

  it('tears down cleanly on done and does not later fire the watchdog', () => {
    jest.useFakeTimers()
    const onSnapshot = jest.fn()
    const onError = jest.fn()

    scanStorageUsage('workspace-db', { onSnapshot, onError })
    const worker = workers()[0]

    worker.onmessage?.({ data: { type: 'done', requestId: 1, snapshot: emptySnapshot(true) } })
    expect(onSnapshot).toHaveBeenCalledTimes(1)
    expect(worker.terminated).toBe(true)

    // The watchdog must have been cleared by teardown; no spurious error later.
    jest.advanceTimersByTime(300_000)
    expect(onError).not.toHaveBeenCalled()
  })
})

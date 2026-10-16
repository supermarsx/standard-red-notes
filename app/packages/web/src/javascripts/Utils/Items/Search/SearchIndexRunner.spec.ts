import { SearchIndexRunner } from './SearchIndexRunner'
import { SearchIndexSettings } from './searchIndexSettings'

type StoredValue = Partial<SearchIndexSettings> | undefined

const makeApplication = () => {
  let stored: StoredValue
  // Capture the progress subscriber the runner registers so tests can simulate a
  // worker progress heartbeat by invoking it directly.
  let progressListener: ((progress: { processed: number; total: number }) => void) | null = null
  const itemListController = {
    rebuildSearchIndex: jest.fn().mockResolvedValue(undefined),
    flushSearchIndex: jest.fn(),
    setSearchIndexScope: jest.fn(),
    setSearchIndexProgressListener: jest.fn((listener: typeof progressListener) => {
      progressListener = listener
    }),
    killSearchIndexWorker: jest.fn(),
    restartSearchIndexWorker: jest.fn(),
    searchIndexState: { isBuilt: false, size: 0, isThreaded: false, isKilled: false },
  }
  const application = {
    getValue: jest.fn(() => stored),
    setValue: jest.fn((_key: string, value: StoredValue) => {
      stored = value
    }),
    setPreference: jest.fn().mockResolvedValue(undefined),
    itemListController,
  }
  return {
    application,
    itemListController,
    getStored: () => stored,
    emitProgress: (processed: number, total: number) => progressListener?.({ processed, total }),
  }
}

describe('SearchIndexRunner', () => {
  describe('idle scheduler lifecycle', () => {
    const cadence = 5 * 60 * 1000
    let callbacks: Map<number, () => void>
    let nextHandle: number
    let originalRequest: PropertyDescriptor | undefined
    let originalCancel: PropertyDescriptor | undefined
    let runner: SearchIndexRunner

    beforeEach(() => {
      jest.useFakeTimers()
      callbacks = new Map()
      nextHandle = 0
      originalRequest = Object.getOwnPropertyDescriptor(globalThis, 'requestIdleCallback')
      originalCancel = Object.getOwnPropertyDescriptor(globalThis, 'cancelIdleCallback')
      Object.defineProperty(globalThis, 'requestIdleCallback', {
        configurable: true,
        value: (callback: () => void) => {
          callbacks.set(++nextHandle, callback)
          return nextHandle
        },
      })
      Object.defineProperty(globalThis, 'cancelIdleCallback', {
        configurable: true,
        value: (handle: number) => callbacks.delete(handle),
      })
    })

    afterEach(() => {
      runner?.deinit()
      for (const [name, descriptor] of [
        ['requestIdleCallback', originalRequest],
        ['cancelIdleCallback', originalCancel],
      ] as const) {
        if (descriptor) {
          Object.defineProperty(globalThis, name, descriptor)
        } else {
          Reflect.deleteProperty(globalThis, name)
        }
      }
      jest.useRealTimers()
    })

    const settle = async () => {
      for (let i = 0; i < 5; i++) {
        await Promise.resolve()
      }
    }
    const grantIdleTime = () => {
      const ready = [...callbacks.values()]
      callbacks.clear()
      ready.forEach((callback) => callback())
    }

    it('enforces a cooldown even when the browser grants idle time immediately', async () => {
      const { application, itemListController } = makeApplication()
      runner = new SearchIndexRunner(application as never)
      await settle()
      runner.setSchedulerMode('idle')

      for (let i = 0; i < 10; i++) {
        grantIdleTime()
        await settle()
      }
      expect(itemListController.rebuildSearchIndex).toHaveBeenCalledTimes(1)
      jest.advanceTimersByTime(cadence)
      grantIdleTime()
      await settle()
      expect(itemListController.rebuildSearchIndex).toHaveBeenCalledTimes(2)
      grantIdleTime()
      await settle()
      expect(itemListController.rebuildSearchIndex).toHaveBeenCalledTimes(2)
    })

    it('cannot re-arm after disposal while an idle rebuild is in flight', async () => {
      const { application, itemListController } = makeApplication()
      runner = new SearchIndexRunner(application as never)
      await settle()
      let finish!: () => void
      itemListController.rebuildSearchIndex.mockImplementationOnce(
        () => new Promise<void>((resolve) => (finish = resolve)),
      )
      runner.setSchedulerMode('idle')
      jest.advanceTimersByTime(cadence)
      grantIdleTime()
      runner.deinit()
      finish()
      await settle()
      jest.advanceTimersByTime(cadence)
      grantIdleTime()
      await settle()
      expect(itemListController.rebuildSearchIndex).toHaveBeenCalledTimes(2)
      expect(callbacks.size).toBe(0)
      expect(jest.getTimerCount()).toBe(0)
      expect(runner.isRunning).toBe(false)
    })

    it('does not let an old completion duplicate a newly armed idle scheduler', async () => {
      const { application, itemListController } = makeApplication()
      runner = new SearchIndexRunner(application as never)
      await settle()
      let finish!: () => void
      itemListController.rebuildSearchIndex.mockImplementationOnce(
        () => new Promise<void>((resolve) => (finish = resolve)),
      )
      runner.setSchedulerMode('idle')
      jest.advanceTimersByTime(cadence)
      grantIdleTime()
      runner.setSchedulerMode('manual')
      runner.setSchedulerMode('idle')
      finish()
      await settle()
      jest.advanceTimersByTime(cadence)
      expect(callbacks.size).toBe(1)
      grantIdleTime()
      await settle()
      expect(itemListController.rebuildSearchIndex).toHaveBeenCalledTimes(3)
      expect(jest.getTimerCount()).toBe(1)
    })

    it('rejects an already queued idle callback after stop and restart', async () => {
      const { application, itemListController } = makeApplication()
      runner = new SearchIndexRunner(application as never)
      await settle()
      runner.setSchedulerMode('idle')
      jest.advanceTimersByTime(cadence)
      const staleCallback = [...callbacks.values()][0]
      expect(staleCallback).toBeDefined()
      runner.stop()
      runner.start()
      await settle()
      staleCallback()
      await settle()
      expect(itemListController.rebuildSearchIndex).toHaveBeenCalledTimes(2)
      expect(jest.getTimerCount()).toBe(1)
      expect(callbacks.size).toBe(0)
    })

    it('uses the same cadence without requestIdleCallback and cancels the pending timer', async () => {
      Reflect.deleteProperty(globalThis, 'requestIdleCallback')
      const { application, itemListController } = makeApplication()
      runner = new SearchIndexRunner(application as never)
      await settle()
      runner.setSchedulerMode('idle')
      jest.advanceTimersByTime(cadence - 1)
      expect(itemListController.rebuildSearchIndex).toHaveBeenCalledTimes(1)
      jest.advanceTimersByTime(1)
      await settle()
      expect(itemListController.rebuildSearchIndex).toHaveBeenCalledTimes(2)
      runner.stop()
      jest.advanceTimersByTime(cadence * 2)
      expect(itemListController.rebuildSearchIndex).toHaveBeenCalledTimes(2)
      expect(jest.getTimerCount()).toBe(0)
    })
  })

  it('pushes the persisted scope into the controller on construction', () => {
    const { application, itemListController } = makeApplication()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new SearchIndexRunner(application as any)
    expect(itemListController.setSearchIndexScope).toHaveBeenCalled()
  })

  it('persists the selected scheduler mode and re-arms while running', () => {
    const { application, getStored } = makeApplication()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = new SearchIndexRunner(application as any)

    runner.setSchedulerMode('interval')
    expect(runner.settings.schedulerMode).toBe('interval')
    expect(getStored()?.schedulerMode).toBe('interval')

    runner.setSchedulerMode('idle')
    expect(runner.settings.schedulerMode).toBe('idle')

    runner.setSchedulerMode('manual')
    expect(runner.settings.schedulerMode).toBe('manual')
  })

  it('arms an interval timer in interval mode and clears it on stop', () => {
    jest.useFakeTimers()
    const setIntervalSpy = jest.spyOn(global, 'setInterval')
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval')
    const { application } = makeApplication()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = new SearchIndexRunner(application as any)

    runner.setSchedulerMode('interval')
    runner.setIntervalMinutes(1)
    expect(setIntervalSpy).toHaveBeenCalled()

    runner.stop()
    expect(clearIntervalSpy).toHaveBeenCalled()
    setIntervalSpy.mockRestore()
    clearIntervalSpy.mockRestore()
    jest.useRealTimers()
  })

  it('does not arm an interval in manual or on-change mode', () => {
    jest.useFakeTimers()
    const setIntervalSpy = jest.spyOn(global, 'setInterval')
    const { application } = makeApplication()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = new SearchIndexRunner(application as any)
    setIntervalSpy.mockClear()

    runner.setSchedulerMode('manual')
    runner.setSchedulerMode('on-change')
    expect(setIntervalSpy).not.toHaveBeenCalled()

    setIntervalSpy.mockRestore()
    jest.useRealTimers()
  })

  it('purges the index via the controller and resets status', () => {
    const { application, itemListController } = makeApplication()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = new SearchIndexRunner(application as any)

    runner.purgeIndex()
    expect(itemListController.flushSearchIndex).toHaveBeenCalledTimes(1)
    expect(runner.isIndexing).toBe(false)
    expect(runner.status).toBe('idle')
  })

  it('setScope persists, syncs to controller, and triggers a rebuild', async () => {
    const { application, itemListController, getStored } = makeApplication()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = new SearchIndexRunner(application as any)
    // Let the constructor's initial rebuildNow() settle so isIndexing is cleared
    // before we exercise setScope (which skips rebuilding mid-flight).
    await Promise.resolve()
    await Promise.resolve()
    itemListController.setSearchIndexScope.mockClear()
    itemListController.rebuildSearchIndex.mockClear()

    runner.setScope({ mode: 'exclude', tagIds: ['secret'] })

    expect(runner.settings.scope).toEqual({ mode: 'exclude', tagIds: ['secret'] })
    expect(getStored()?.scope).toEqual({ mode: 'exclude', tagIds: ['secret'] })
    expect(itemListController.setSearchIndexScope).toHaveBeenCalledWith({ mode: 'exclude', tagIds: ['secret'] })
    expect(itemListController.rebuildSearchIndex).toHaveBeenCalled()
  })

  it('killWorker terminates the worker via the controller, stops the runner, and reports stopped', () => {
    jest.useFakeTimers()
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval')
    const { application, itemListController } = makeApplication()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = new SearchIndexRunner(application as any)
    runner.setSchedulerMode('interval')
    runner.setIntervalMinutes(1)

    runner.killWorker()

    expect(itemListController.killSearchIndexWorker).toHaveBeenCalledTimes(1)
    expect(runner.isWorkerKilled).toBe(true)
    expect(runner.isRunning).toBe(false)
    expect(runner.status).toBe('stopped')
    expect(runner.currentJob).toBeNull()
    // The scheduler was cleared so no fresh work is handed to the dead worker.
    expect(clearIntervalSpy).toHaveBeenCalled()

    clearIntervalSpy.mockRestore()
    jest.useRealTimers()
  })

  it('restartWorker re-spawns the worker via the controller and resumes running', () => {
    const { application, itemListController } = makeApplication()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = new SearchIndexRunner(application as any)

    runner.killWorker()
    expect(runner.isWorkerKilled).toBe(true)

    runner.restartWorker()

    expect(itemListController.restartSearchIndexWorker).toHaveBeenCalledTimes(1)
    expect(runner.isWorkerKilled).toBe(false)
    expect(runner.isRunning).toBe(true)
    expect(runner.status).not.toBe('stopped')
  })

  it('surfaces the worker current-job progress heartbeat as observable currentJob', () => {
    const { application, emitProgress } = makeApplication()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = new SearchIndexRunner(application as any)

    expect(runner.currentJob).toBeNull()

    emitProgress(200, 1000)
    expect(runner.currentJob).toEqual({ processed: 200, total: 1000 })

    emitProgress(1000, 1000)
    expect(runner.currentJob).toEqual({ processed: 1000, total: 1000 })
  })

  it('clears the progress subscription on deinit', () => {
    const { application, itemListController } = makeApplication()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = new SearchIndexRunner(application as any)
    itemListController.setSearchIndexProgressListener.mockClear()

    runner.deinit()

    expect(itemListController.setSearchIndexProgressListener).toHaveBeenCalledWith(null)
  })
})

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

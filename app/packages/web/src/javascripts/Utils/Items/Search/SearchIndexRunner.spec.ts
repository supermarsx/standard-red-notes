import { SearchIndexRunner } from './SearchIndexRunner'
import { SearchIndexSettings } from './searchIndexSettings'

type StoredValue = Partial<SearchIndexSettings> | undefined

const makeApplication = () => {
  let stored: StoredValue
  const itemListController = {
    rebuildSearchIndex: jest.fn().mockResolvedValue(undefined),
    flushSearchIndex: jest.fn(),
    setSearchIndexScope: jest.fn(),
    searchIndexState: { isBuilt: false, size: 0, isThreaded: false },
  }
  const application = {
    getValue: jest.fn(() => stored),
    setValue: jest.fn((_key: string, value: StoredValue) => {
      stored = value
    }),
    setPreference: jest.fn().mockResolvedValue(undefined),
    itemListController,
  }
  return { application, itemListController, getStored: () => stored }
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
})

/** @jest-environment jsdom */
// @ts-expect-error CSS is not provided by jsdom; imported editor modules inspect it.
global.CSS = {}

jest.mock('@/Achievements', () => ({ achievements: { increment: jest.fn() }, METRICS: { manualSyncTotal: 'manual' } }))
jest.mock('@standardnotes/toast', () => ({
  ToastType: { Success: 'success', Error: 'error' },
  addToast: jest.fn(),
  updateToast: jest.fn(),
  dismissToast: jest.fn(),
}))

import { ApplicationEvent } from '@standardnotes/snjs'
import { addToast } from '@standardnotes/toast'
import Footer from './Footer'

const buildFooter = () => {
  const stats = { downloadCount: 0, uploadTotalCount: 1, uploadCompletionCount: 0 }
  const syncStatus = {
    getStats: () => stats,
    hasError: () => false,
    syncInProgress: true,
    secondsSinceSyncStart: 0,
  }
  const status = {
    message: '',
    setMessage: jest.fn((message: string) => {
      status.message = message
    }),
    addEventObserver: () => () => undefined,
  }
  const application = {
    status,
    sync: { getSyncStatus: () => syncStatus, sync: jest.fn(async (): Promise<void> => undefined) },
    addWebEventObserver: () => () => undefined,
    addEventObserver: () => () => undefined,
    isStarted: () => false,
    isLaunched: () => false,
    sessions: { isSignedOut: () => false },
    items: { getNoteCount: () => 1 },
  }
  const footer = new Footer({
    application: application as never,
    applicationGroup: { getDescriptors: () => [] } as never,
  })
  footer.setState = jest.fn((update) => {
    Object.assign(footer.state, update)
  }) as typeof footer.setState
  footer.componentDidMount()
  return { footer, application, status, syncStatus, stats }
}

beforeEach(() => {
  jest.useFakeTimers()
  jest.clearAllMocks()
})

afterEach(() => jest.useRealTimers())

it('keeps routine small saves quiet without repeated status writes or erasing other feedback', () => {
  const { footer, status } = buildFooter()
  try {
    footer.onAppEvent(ApplicationEvent.CompletedFullSync)
    status.setMessage.mockClear()
    for (let index = 0; index < 10; index++) {
      footer.onAppEvent(ApplicationEvent.WillSync)
      footer.onAppEvent(ApplicationEvent.SyncStatusChanged)
    }
    expect(status.setMessage).not.toHaveBeenCalled()
    status.message = 'Saving local backup…'
    footer.updateSyncStatus()
    expect(status.message).toBe('Saving local backup…')
    expect(status.setMessage).not.toHaveBeenCalled()
  } finally {
    footer.deinit()
  }
})

it('keeps initial sync and bulk progress visible while coalescing unchanged messages', () => {
  const { footer, status, stats } = buildFooter()
  try {
    footer.onAppEvent(ApplicationEvent.WillSync)
    footer.onAppEvent(ApplicationEvent.WillSync)
    expect(status.setMessage.mock.calls).toEqual([['Syncing…']])
    stats.downloadCount = 30
    footer.updateSyncStatus()
    expect(status.message).toBe('Downloading 30 items. Keep app open.')
    stats.downloadCount = 0
    footer.updateSyncStatus()
    expect(status.message).toBe('Download Complete.')
    stats.uploadTotalCount = 40
    stats.uploadCompletionCount = 20
    footer.updateSyncStatus()
    const uploadMessage = status.message
    expect(uploadMessage).toContain('Syncing 40 items')
    jest.advanceTimersByTime(2000)
    expect(status.message).toBe(uploadMessage)
    const writes = status.setMessage.mock.calls.length
    footer.updateSyncStatus()
    expect(status.setMessage).toHaveBeenCalledTimes(writes)
  } finally {
    footer.deinit()
  }
})

it('surfaces a stalled small save and errors immediately, then clears its own completed message', () => {
  const { footer, status, syncStatus } = buildFooter()
  try {
    syncStatus.secondsSinceSyncStart = 6
    footer.onAppEvent(ApplicationEvent.HighLatencySync)
    expect(status.message).toBe('Syncing… Taking longer than usual.')
    syncStatus.hasError = () => true
    footer.updateSyncStatus()
    expect(status.message).toBe('Unable to Sync')
    syncStatus.hasError = () => false
    syncStatus.syncInProgress = false
    footer.updateSyncStatus()
    expect(status.message).toBe('')
  } finally {
    footer.deinit()
  }
})

it('keeps explicit manual sync feedback and actually awaits persistence', async () => {
  const { footer, application } = buildFooter()
  try {
    let complete: (() => void) | undefined
    application.sync.sync.mockImplementationOnce(() => new Promise<void>((resolve) => (complete = resolve)))
    const pending = footer.syncNowClickHandler()
    expect(footer.state.syncingNow).toBe(true)
    expect(application.sync.sync).toHaveBeenCalledWith({ isUserInitiated: true })
    complete?.()
    await pending
    expect(footer.state.syncingNow).toBe(false)
    expect(addToast).toHaveBeenCalledWith({ type: 'success', message: 'Sync complete.' })
  } finally {
    footer.deinit()
  }
})

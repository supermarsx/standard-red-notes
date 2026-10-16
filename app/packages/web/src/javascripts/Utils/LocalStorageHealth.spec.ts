/** @jest-environment jsdom */
jest.mock('@standardnotes/toast', () => ({ addToast: jest.fn(), dismissToast: jest.fn(), ToastType: { Error: 1 } }))
let health: typeof import('./LocalStorageHealth')
let toast: typeof import('@standardnotes/toast')
beforeEach(async () => {
  jest.resetModules()
  toast = await import('@standardnotes/toast')
  jest.mocked(toast.addToast).mockReturnValue('storage-warning')
  health = await import('./LocalStorageHealth')
})
afterEach(() => jest.useRealTimers())
const estimate = (usedFraction: number) => ({ usage: usedFraction * 100, quota: 100, usedFraction })

it('shows one persistent actionable quota warning without claiming the physical disk is definitely full', () => {
  health.reportLocalStorageHealth('quota-exceeded', 'outbox')
  health.reportLocalStorageHealth('quota-exceeded', 'outbox')
  expect(toast.addToast).toHaveBeenCalledTimes(1)
  const notice = jest.mocked(toast.addToast).mock.calls[0][0]
  expect(notice.autoClose).toBe(false)
  expect(notice.message).toContain('browser quota')
  expect(notice.message).toContain('Free space on this computer')
  expect(notice.message).toContain('Do not clear this site')
  const openPreferences = jest.fn()
  window.mainApplicationGroup = { primaryApplication: { openPreferences } } as never
  notice.actions![0].handler?.('storage-warning')
  expect(openPreferences).toHaveBeenCalledWith('storage')
  delete window.mainApplicationGroup
})

it('requires healthy writes from the failing store, then rearms a later failure', () => {
  health.reportLocalStorageHealth('quota-exceeded', 'outbox')
  health.reportLocalStorageHealth('write-ok', 'items')
  expect(toast.dismissToast).not.toHaveBeenCalled()
  health.reportStorageEstimate(estimate(0.1))
  expect(toast.dismissToast).not.toHaveBeenCalled()
  health.reportLocalStorageHealth('write-ok', 'outbox')
  expect(toast.dismissToast).toHaveBeenCalledTimes(1)
  health.reportLocalStorageHealth('quota-exceeded', 'outbox')
  expect(toast.addToast).toHaveBeenCalledTimes(2)
})

it('keeps failures in both stores independent and prioritizes authoritative quota failures', () => {
  health.reportLocalStorageHealth('database-unavailable', 'outbox')
  expect(jest.mocked(toast.addToast).mock.calls[0][0].message).toContain('database is unavailable')
  health.reportLocalStorageHealth('quota-exceeded', 'items')
  expect(jest.mocked(toast.addToast).mock.calls[1][0].message).toContain('browser quota')
  health.reportLocalStorageHealth('write-ok', 'outbox')
  expect(toast.addToast).toHaveBeenCalledTimes(2)
  health.reportLocalStorageHealth('write-ok', 'items')
  expect(toast.dismissToast).toHaveBeenCalledTimes(2)
})

it('treats quota pressure as advisory and an absent estimate as unknown, not recovery', () => {
  health.reportStorageEstimate(estimate(0.9))
  health.reportStorageEstimate(undefined)
  health.reportStorageEstimate({ usage: 0, quota: 0, usedFraction: 0 })
  expect(toast.addToast).toHaveBeenCalledTimes(1)
  expect(toast.dismissToast).not.toHaveBeenCalled()
  expect(jest.mocked(toast.addToast).mock.calls[0][0].message).toContain('not the computer’s remaining disk space')
  health.reportStorageEstimate(estimate(0.5))
  expect(toast.dismissToast).toHaveBeenCalledTimes(1)
})

it('never throws into persistence when warning UI fails', () => {
  jest.mocked(toast.addToast).mockImplementation(() => {
    throw new Error('UI unavailable')
  })
  expect(() => health.reportLocalStorageHealth('quota-exceeded', 'items')).not.toThrow()
  expect(() => health.reportLocalStorageHealth('write-ok', 'items')).not.toThrow()
  expect(() => health.reportStorageEstimate(estimate(0.9))).not.toThrow()
})

it('retries a failed warning render when the same failure is observed again', () => {
  jest.mocked(toast.addToast).mockImplementationOnce(() => {
    throw new Error('UI unavailable')
  })
  health.reportLocalStorageHealth('quota-exceeded', 'outbox')
  health.reportLocalStorageHealth('quota-exceeded', 'outbox')
  expect(toast.addToast).toHaveBeenCalledTimes(2)
  health.reportLocalStorageHealth('quota-exceeded', 'outbox')
  expect(toast.addToast).toHaveBeenCalledTimes(2)
})

it('coalesces visible wake probes, skips hidden/offline work, and ignores late results after cleanup', async () => {
  jest.useFakeTimers()
  const visible = jest.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const online = jest.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
  let finish!: (value: ReturnType<typeof estimate>) => void
  const probe = jest.fn().mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const report = jest.fn()
  const stop = health.watchStoragePressure(probe, report)
  try {
    window.dispatchEvent(new Event('focus'))
    expect(probe).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(60_000)
    visible.mockReturnValue('hidden')
    window.dispatchEvent(new Event('focus'))
    visible.mockReturnValue('visible')
    online.mockReturnValue(false)
    window.dispatchEvent(new Event('online'))
    expect(probe).not.toHaveBeenCalled()
    online.mockReturnValue(true)
    for (let index = 0; index < 10; index++) window.dispatchEvent(new Event('focus'))
    expect(probe).toHaveBeenCalledTimes(1)
    stop()
    finish(estimate(0.9))
    await jest.advanceTimersByTimeAsync(5 * 60_000)
    expect(report).not.toHaveBeenCalled()
    expect(probe).toHaveBeenCalledTimes(1)
  } finally {
    stop()
    visible.mockRestore()
    online.mockRestore()
  }
})

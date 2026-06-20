import { LoggerInterface } from '@standardnotes/utils'
import { SyncSource } from '@standardnotes/services'
import { SyncService } from './SyncService'

describe('SyncService failure backoff', () => {
  let logger: jest.Mocked<LoggerInterface>

  const createService = (): SyncService => {
    logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as jest.Mocked<LoggerInterface>

    const noop = () => undefined

    /**
     * The backoff logic under test only depends on `logger`, the internal failure counter,
     * and `setTimeout`. The remaining constructor dependencies are never touched by these
     * paths, so lightweight stubs are sufficient.
     */
    const service = new SyncService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      'test-identifier',
      {} as never,
      logger,
      {} as never,
      {} as never,
      {} as never,
      { addEventHandler: noop } as never,
    )

    return service
  }

  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  const failureCount = (service: SyncService) => (service as unknown as { consecutiveFailureCount: number }).consecutiveFailureCount
  const hasPendingBackoff = (service: SyncService) =>
    (service as unknown as { failureBackoffTimeout?: unknown }).failureBackoffTimeout != undefined

  it('schedules a backoff retry and increments the counter on a failed online sync result', () => {
    const service = createService()

    const scheduled = service.applyOnlineSyncResult(true, true)

    expect(scheduled).toBe(true)
    expect(failureCount(service)).toBe(1)
    expect(hasPendingBackoff(service)).toBe(true)
  })

  it('grows the failure counter across consecutive failed online sync results', () => {
    const service = createService()

    service.applyOnlineSyncResult(true, true)
    service.applyOnlineSyncResult(true, true)
    service.applyOnlineSyncResult(true, true)

    expect(failureCount(service)).toBe(3)
    expect(hasPendingBackoff(service)).toBe(true)
  })

  it('resets the counter and cancels the pending retry on a successful online sync result', () => {
    const service = createService()

    service.applyOnlineSyncResult(true, true)
    expect(failureCount(service)).toBe(1)

    const scheduled = service.applyOnlineSyncResult(false, true)

    expect(scheduled).toBe(false)
    expect(failureCount(service)).toBe(0)
    expect(hasPendingBackoff(service)).toBe(false)
  })

  it('does not trip the online backoff for benign offline (no-server) sync results', () => {
    const service = createService()

    const failedOffline = service.applyOnlineSyncResult(true, false)
    const succeededOffline = service.applyOnlineSyncResult(false, false)

    expect(failedOffline).toBe(false)
    expect(succeededOffline).toBe(false)
    expect(failureCount(service)).toBe(0)
    expect(hasPendingBackoff(service)).toBe(false)
  })

  it('fires a BackoffRetry sync (not cancelled by its own scheduled invocation) when the timer elapses', () => {
    const service = createService()

    const syncSpy = jest.spyOn(service, 'sync').mockResolvedValue(undefined)

    service.applyOnlineSyncResult(true, true)
    expect(hasPendingBackoff(service)).toBe(true)

    jest.runOnlyPendingTimers()

    expect(syncSpy).toHaveBeenCalledTimes(1)
    expect(syncSpy).toHaveBeenCalledWith(expect.objectContaining({ source: SyncSource.BackoffRetry }))
  })

  it('cancels a pending backoff retry when a fresh non-retry sync is requested', async () => {
    const service = createService()

    service.applyOnlineSyncResult(true, true)
    expect(hasPendingBackoff(service)).toBe(true)

    // A fresh user/auto sync should bypass the pending backoff timer.
    ;(service as unknown as { performSync: (o: unknown) => Promise<unknown> }).performSync = jest
      .fn()
      .mockResolvedValue(undefined)
    await service.sync({ source: SyncSource.External })

    expect(hasPendingBackoff(service)).toBe(false)
  })
})

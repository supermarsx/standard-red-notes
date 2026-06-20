import { LoggerInterface } from '@standardnotes/utils'
import { SyncSource } from '@standardnotes/services'
import { SyncService } from './SyncService'
import {
  DecryptedItemInterface,
  DeletedItemInterface,
} from '@standardnotes/models'

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

describe('SyncService local-only exclusion (excludeLocalOnlyItems)', () => {
  /**
   * Builds a minimal item shaped enough for the filter, which only inspects:
   *  - `payload.deleted` (via isDeletedItem)
   *  - `localOnly` (for decrypted items)
   */
  const makeDecryptedItem = (uuid: string, localOnly: boolean): DecryptedItemInterface =>
    ({
      uuid,
      localOnly,
      payload: { deleted: false },
    }) as unknown as DecryptedItemInterface

  const makeDeletedItem = (uuid: string): DeletedItemInterface =>
    ({
      uuid,
      payload: { deleted: true },
    }) as unknown as DeletedItemInterface

  it('keeps a normal (syncing) item in the upload set', () => {
    const normal = makeDecryptedItem('normal', false)

    const result = SyncService.excludeLocalOnlyItems([normal])

    expect(result).toContain(normal)
    expect(result).toHaveLength(1)
  })

  it('removes a local-only item from the upload set', () => {
    const localOnly = makeDecryptedItem('local-only', true)

    const result = SyncService.excludeLocalOnlyItems([localOnly])

    expect(result).not.toContain(localOnly)
    expect(result).toHaveLength(0)
  })

  it('keeps normal items and drops local-only items in a mixed set', () => {
    const normalA = makeDecryptedItem('a', false)
    const localOnlyB = makeDecryptedItem('b', true)
    const normalC = makeDecryptedItem('c', false)

    const result = SyncService.excludeLocalOnlyItems([normalA, localOnlyB, normalC])

    expect(result).toEqual([normalA, normalC])
  })

  it('re-includes an item once its local-only flag is cleared (re-enable path)', () => {
    // Simulates the flag being toggled off: the same uuid now reports localOnly === false.
    const reEnabled = makeDecryptedItem('was-local-only', false)

    const result = SyncService.excludeLocalOnlyItems([reEnabled])

    expect(result).toContain(reEnabled)
  })

  it('never excludes deleted items, so deletions still propagate', () => {
    // A deleted item cannot carry the decrypted local-only flag and must always be allowed
    // through so its deletion can be persisted/uploaded.
    const deleted = makeDeletedItem('deleted')

    const result = SyncService.excludeLocalOnlyItems([deleted])

    expect(result).toContain(deleted)
  })
})

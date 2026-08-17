import { LoggerInterface } from '@standardnotes/utils'
import { StorageKey, SyncEvent, SyncMode, SyncSource, WebSocketsServiceEvent } from '@standardnotes/services'
import { SyncService } from './SyncService'
import { SNLog } from '../../Log'
import {
  DecryptedItemInterface,
  DecryptedPayload,
  DeletedItemInterface,
  FillItemContent,
  FullyFormedPayloadInterface,
  ImmutablePayloadCollection,
  LitePayloadSafetyError,
  NoteContent,
  CreateOfflineSyncSavedPayload,
  CreateServerSyncSavedPayload,
  PayloadEmitSource,
  PayloadSource,
  PayloadTimestampDefaults,
  createLitePayloadFromDecrypted,
  getCurrentDirtyIndex,
  getIncrementedDirtyIndex,
  isLitePayload,
} from '@standardnotes/models'
import { ContentType } from '@standardnotes/domain-core'

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

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

  const failureCount = (service: SyncService) =>
    (service as unknown as { consecutiveFailureCount: number }).consecutiveFailureCount
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

describe('SyncService websocket push apply (Phase 1A)', () => {
  let logger: jest.Mocked<LoggerInterface>
  let storage: {
    values: Record<string, unknown>
    getValue: jest.Mock
    setValue: jest.Mock
    setValueAndAwaitPersist: jest.Mock
    setValuesAtomicallyAndAwaitPersist: jest.Mock
    removeValue: jest.Mock
    savePayloads: jest.Mock
  }
  let payloadManager: { getMasterCollection: jest.Mock; emitDeltaEmit: jest.Mock; emitPayloads: jest.Mock }
  let historyService: { getHistoryMapCopy: jest.Mock }
  let encryptionService: { decryptSplit: jest.Mock }
  let livePayloads: Map<string, FullyFormedPayloadInterface>

  const StorageKeySyncPositionCheckpoint = 'syncPositionCheckpoint'

  const storedSyncToken = () =>
    (storage.values[StorageKeySyncPositionCheckpoint] as { syncToken?: string } | undefined)?.syncToken

  const createService = (currentToken?: string): SyncService => {
    logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as jest.Mocked<LoggerInterface>

    const noop = () => undefined

    storage = {
      values: currentToken
        ? {
            [StorageKeySyncPositionCheckpoint]: {
              version: 1,
              revision: 1,
              syncToken: currentToken,
            },
          }
        : {},
      getValue: jest.fn(),
      setValue: jest.fn(),
      setValueAndAwaitPersist: jest.fn(),
      setValuesAtomicallyAndAwaitPersist: jest.fn(),
      removeValue: jest.fn(),
      savePayloads: jest.fn().mockResolvedValue(undefined),
    }
    storage.getValue.mockImplementation((key: string) => storage.values[key])
    storage.setValue.mockImplementation((key: string, value: string) => {
      storage.values[key] = value
    })
    // setLastSyncToken now routes through the awaited-persist API (D2 critical-key routing).
    storage.setValueAndAwaitPersist.mockImplementation(async (key: string, value: string) => {
      storage.values[key] = value
    })
    storage.setValuesAtomicallyAndAwaitPersist.mockImplementation(async (values: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) {
          delete storage.values[key]
        } else {
          storage.values[key] = value
        }
      }
    })
    storage.removeValue.mockImplementation(async (key: string) => {
      delete storage.values[key]
    })

    livePayloads = new Map()
    const applyPayloads = async (payloads: FullyFormedPayloadInterface[]) => {
      for (const payload of payloads) {
        if (payload.deleted && !payload.dirty) {
          livePayloads.delete(payload.uuid)
        } else {
          livePayloads.set(payload.uuid, payload)
        }
      }
      return payloads
    }
    payloadManager = {
      getMasterCollection: jest
        .fn()
        .mockImplementation(() => ImmutablePayloadCollection.WithPayloads([...livePayloads.values()])),
      emitDeltaEmit: jest.fn().mockImplementation(async (emit: { emits: FullyFormedPayloadInterface[] }) => {
        return applyPayloads(emit.emits)
      }),
      emitPayloads: jest.fn().mockImplementation(applyPayloads),
    }
    historyService = { getHistoryMapCopy: jest.fn().mockReturnValue({}) }
    encryptionService = { decryptSplit: jest.fn().mockResolvedValue([]) }

    const service = new SyncService(
      {} as never, // itemManager
      {} as never, // sessionManager
      encryptionService as never,
      storage as never, // storageService
      payloadManager as never,
      {} as never, // apiService
      historyService as never,
      {} as never, // device
      'test-identifier',
      {} as never, // options
      logger,
      {} as never, // sockets
      {} as never, // syncFrequencyGuard
      {} as never, // syncBackoffService
      { addEventHandler: noop, publish: noop, publishSync: noop } as never,
    )

    // Default: database loaded, nothing in progress.
    ;(service as unknown as { databaseLoaded: boolean }).databaseLoaded = true
    ;(service as unknown as { opStatus: { syncInProgress: boolean } }).opStatus = { syncInProgress: false } as never
    ;(service as unknown as { syncLock: boolean }).syncLock = false

    return service
  }

  const dispatchPush = (service: SyncService, data: unknown) =>
    service.handleEvent({ type: WebSocketsServiceEvent.SyncItemsPushed, payload: data } as never)

  beforeAll(() => {
    SNLog.onError = jest.fn()
  })

  it('applies an in-order push directly without an HTTP sync and advances the token', async () => {
    const service = createService('base-token')
    const syncSpy = jest.spyOn(service, 'sync').mockResolvedValue(undefined)
    // The pushed items are decrypted/applied via the real pipeline; with no items
    // the resolver emits empty deltas and we just advance the token.
    ;(service as unknown as { persistPayloads: jest.Mock }).persistPayloads = jest.fn().mockResolvedValue(undefined)

    await dispatchPush(service, { items: [], syncToken: 'new-token', baseSyncToken: 'base-token' })

    expect(syncSpy).not.toHaveBeenCalled()
    expect(storedSyncToken()).toEqual('new-token')
  })

  it('discards the push and triggers an HTTP sync on a token mismatch/gap', async () => {
    const service = createService('different-token')
    const syncSpy = jest.spyOn(service, 'sync').mockResolvedValue(undefined)

    await dispatchPush(service, { items: [], syncToken: 'new-token', baseSyncToken: 'base-token' })

    expect(syncSpy).toHaveBeenCalledTimes(1)
    // Token must NOT be advanced when we discard the push.
    expect(storedSyncToken()).toEqual('different-token')
    expect((service as unknown as { wasNotifiedOfItemsChangeOnServer: boolean }).wasNotifiedOfItemsChangeOnServer).toBe(
      true,
    )
  })

  it('discards the push and triggers an HTTP sync when a sync is already in progress', async () => {
    const service = createService('base-token')
    ;(service as unknown as { opStatus: { syncInProgress: boolean } }).opStatus.syncInProgress = true
    const syncSpy = jest.spyOn(service, 'sync').mockResolvedValue(undefined)

    await dispatchPush(service, { items: [], syncToken: 'new-token', baseSyncToken: 'base-token' })

    expect(syncSpy).toHaveBeenCalledTimes(1)
    expect(storedSyncToken()).toEqual('base-token')
  })

  it('falls back to an HTTP sync if applying the push throws, without advancing the token', async () => {
    const service = createService('base-token')
    const syncSpy = jest.spyOn(service, 'sync').mockResolvedValue(undefined)
    // Force the apply pipeline to throw.
    ;(service as unknown as { processServerPayloads: jest.Mock }).processServerPayloads = jest
      .fn()
      .mockRejectedValue(new Error('boom'))

    await dispatchPush(service, { items: [{ uuid: 'x' }], syncToken: 'new-token', baseSyncToken: 'base-token' })

    expect(syncSpy).toHaveBeenCalledTimes(1)
    expect(storedSyncToken()).toEqual('base-token')
    expect(logger.error).toHaveBeenCalled()
  })

  it('restores state after a payload write failure, retains the previous token, and starts HTTP recovery', async () => {
    const service = createService('base-token')
    const syncSpy = jest.spyOn(service, 'sync').mockResolvedValue(undefined)
    const remote = new DecryptedPayload<NoteContent>(
      {
        uuid: 'websocket-persist-failure',
        content_type: ContentType.TYPES.Note,
        content: FillItemContent<NoteContent>({ title: 'Remote', text: 'body' }),
        ...PayloadTimestampDefaults(),
      },
      PayloadSource.RemoteRetrieved,
    )
    ;(service as unknown as { processServerPayloads: jest.Mock }).processServerPayloads = jest
      .fn()
      .mockResolvedValue([remote])
    livePayloads.set(remote.uuid, remote.copy({ dirty: true }, PayloadSource.Constructor))
    const localBeforePush = livePayloads.get(remote.uuid)

    const quota = new Error('The quota has been exceeded.')
    quota.name = 'QuotaExceededError'
    storage.savePayloads.mockRejectedValue(quota)

    await expect(
      dispatchPush(service, { items: [], syncToken: 'new-token', baseSyncToken: 'base-token' }),
    ).resolves.toBeUndefined()

    expect(payloadManager.emitDeltaEmit).toHaveBeenCalled()
    expect(livePayloads.get(remote.uuid)).toBe(localBeforePush)
    expect(livePayloads.get(remote.uuid)?.dirty).toBe(true)
    expect(storage.setValuesAtomicallyAndAwaitPersist).not.toHaveBeenCalled()
    expect(storedSyncToken()).toEqual('base-token')
    expect(syncSpy).toHaveBeenCalledTimes(1)
    expect((service as unknown as { syncLock: symbol | false }).syncLock).toBe(false)
  })

  it('does not reject or advance the websocket token when the token write itself fails', async () => {
    const service = createService('base-token')
    const syncSpy = jest.spyOn(service, 'sync').mockResolvedValue(undefined)
    const writeError = new Error('sync-token IndexedDB transaction aborted')
    storage.setValuesAtomicallyAndAwaitPersist.mockRejectedValue(writeError)

    await expect(
      dispatchPush(service, { items: [], syncToken: 'new-token', baseSyncToken: 'base-token' }),
    ).resolves.toBeUndefined()

    expect(storedSyncToken()).toEqual('base-token')
    expect(
      (service as unknown as { syncPositionCheckpoint?: { syncToken?: string } }).syncPositionCheckpoint?.syncToken,
    ).toEqual('base-token')
    expect(storage.setValuesAtomicallyAndAwaitPersist).toHaveBeenCalledTimes(1)
    expect(syncSpy).toHaveBeenCalledTimes(1)
    expect((service as unknown as { syncLock: symbol | false }).syncLock).toBe(false)
  })

  it('persists sync and pagination tokens as one versioned checkpoint', async () => {
    const service = createService('old-sync-token')
    storage.values[StorageKeySyncPositionCheckpoint] = {
      version: 1,
      revision: 7,
      syncToken: 'old-sync-token',
      paginationToken: 'old-pagination-token',
    }

    await expect(
      (
        service as unknown as {
          setSyncTokens: (syncToken: string, paginationToken?: string) => Promise<void>
        }
      ).setSyncTokens('new-sync-token', 'new-pagination-token'),
    ).resolves.toBeUndefined()

    expect(storage.setValuesAtomicallyAndAwaitPersist).toHaveBeenCalledTimes(1)
    expect(storage.values[StorageKeySyncPositionCheckpoint]).toEqual({
      version: 1,
      revision: 8,
      syncToken: 'new-sync-token',
      paginationToken: 'new-pagination-token',
    })
    expect(storage.values[StorageKey.LastSyncToken]).toBeUndefined()
    expect(storage.values[StorageKey.PaginationToken]).toBeUndefined()
  })

  it('migrates both legacy cursor keys with the checkpoint in one atomic write', async () => {
    const service = createService()
    storage.values[StorageKey.LastSyncToken] = 'legacy-sync-token'
    storage.values[StorageKey.PaginationToken] = 'legacy-pagination-token'

    const [syncToken, paginationToken] = await Promise.all([
      (
        service as unknown as {
          getLastSyncToken: () => Promise<string | undefined>
        }
      ).getLastSyncToken(),
      (
        service as unknown as {
          getPaginationToken: () => Promise<string | undefined>
        }
      ).getPaginationToken(),
    ])

    expect(syncToken).toBe('legacy-sync-token')
    expect(paginationToken).toBe('legacy-pagination-token')
    expect(storage.setValuesAtomicallyAndAwaitPersist).toHaveBeenCalledTimes(1)
    expect(storage.values[StorageKeySyncPositionCheckpoint]).toEqual({
      version: 1,
      revision: 1,
      syncToken: 'legacy-sync-token',
      paginationToken: 'legacy-pagination-token',
    })
    expect(storage.values[StorageKey.LastSyncToken]).toBeUndefined()
    expect(storage.values[StorageKey.PaginationToken]).toBeUndefined()
  })

  it('uses a valid checkpoint after restart and ignores stale legacy cursor keys', async () => {
    const service = createService()
    storage.values[StorageKeySyncPositionCheckpoint] = {
      version: 1,
      revision: 12,
      syncToken: 'checkpoint-sync-token',
      paginationToken: 'checkpoint-pagination-token',
    }
    storage.values[StorageKey.LastSyncToken] = 'stale-legacy-sync-token'
    storage.values[StorageKey.PaginationToken] = 'stale-legacy-pagination-token'

    await expect(
      (
        service as unknown as {
          getLastSyncToken: () => Promise<string | undefined>
        }
      ).getLastSyncToken(),
    ).resolves.toBe('checkpoint-sync-token')
    await expect(
      (
        service as unknown as {
          getPaginationToken: () => Promise<string | undefined>
        }
      ).getPaginationToken(),
    ).resolves.toBe('checkpoint-pagination-token')
    expect(storage.setValuesAtomicallyAndAwaitPersist).not.toHaveBeenCalled()
  })

  it('fails safe to a full sync when the checkpoint is malformed', async () => {
    const service = createService()
    storage.values[StorageKeySyncPositionCheckpoint] = {
      version: 1,
      revision: 'not-a-number',
      syncToken: 'untrusted-checkpoint-token',
    }
    storage.values[StorageKey.LastSyncToken] = 'stale-legacy-sync-token'

    await expect(
      (
        service as unknown as {
          getLastSyncToken: () => Promise<string | undefined>
        }
      ).getLastSyncToken(),
    ).resolves.toBeUndefined()

    expect(storage.setValuesAtomicallyAndAwaitPersist).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(
      'Ignoring malformed sync position checkpoint and restarting sync from the beginning',
    )
  })

  it('fails closed when the atomic legacy migration write rejects', async () => {
    const service = createService()
    const writeError = new Error('migration raw write failed')
    storage.values[StorageKey.LastSyncToken] = 'legacy-sync-token'
    storage.values[StorageKey.PaginationToken] = 'legacy-pagination-token'
    storage.setValuesAtomicallyAndAwaitPersist.mockRejectedValue(writeError)

    await expect(
      (
        service as unknown as {
          getLastSyncToken: () => Promise<string | undefined>
        }
      ).getLastSyncToken(),
    ).rejects.toBe(writeError)

    expect(storage.values[StorageKeySyncPositionCheckpoint]).toBeUndefined()
    expect(storage.values[StorageKey.LastSyncToken]).toBe('legacy-sync-token')
    expect(storage.values[StorageKey.PaginationToken]).toBe('legacy-pagination-token')
  })

  it('clears legacy cursors for a new database with one atomic checkpoint write', async () => {
    const service = createService()
    storage.values[StorageKey.LastSyncToken] = 'legacy-sync-token'
    storage.values[StorageKey.PaginationToken] = 'legacy-pagination-token'

    await service.onNewDatabaseCreated()

    expect(storage.setValuesAtomicallyAndAwaitPersist).toHaveBeenCalledTimes(1)
    expect(storage.values[StorageKeySyncPositionCheckpoint]).toEqual({
      version: 1,
      revision: 1,
    })
    expect(storage.values[StorageKey.LastSyncToken]).toBeUndefined()
    expect(storage.values[StorageKey.PaginationToken]).toBeUndefined()
  })

  it('serializes checkpoint writers and advances the revision in commit order', async () => {
    const service = createService('base-token')
    let releaseFirstWrite!: () => void
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve
    })

    storage.setValuesAtomicallyAndAwaitPersist
      .mockImplementationOnce(async (values: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(values)) {
          if (value === undefined) {
            delete storage.values[key]
          } else {
            storage.values[key] = value
          }
        }
        await firstWrite
      })
      .mockImplementationOnce(async (values: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(values)) {
          if (value === undefined) {
            delete storage.values[key]
          } else {
            storage.values[key] = value
          }
        }
      })

    const pairWrite = (
      service as unknown as {
        setSyncTokens: (syncToken: string, paginationToken?: string) => Promise<void>
      }
    ).setSyncTokens('page-token', 'next-page')
    await new Promise((resolve) => setImmediate(resolve))

    const websocketWrite = (
      service as unknown as {
        setLastSyncToken: (syncToken: string) => Promise<void>
      }
    ).setLastSyncToken('websocket-token')
    expect(storage.setValuesAtomicallyAndAwaitPersist).toHaveBeenCalledTimes(1)

    releaseFirstWrite()
    await Promise.all([pairWrite, websocketWrite])

    expect(storage.setValuesAtomicallyAndAwaitPersist).toHaveBeenCalledTimes(2)
    expect(storage.values[StorageKeySyncPositionCheckpoint]).toEqual({
      version: 1,
      revision: 3,
      syncToken: 'websocket-token',
      paginationToken: 'next-page',
    })
  })

  it('does not issue a compensating disk write when an atomic checkpoint write rejects', async () => {
    const service = createService('old-sync-token')
    const writeError = new Error('checkpoint write rejected')
    storage.setValuesAtomicallyAndAwaitPersist.mockRejectedValue(writeError)

    await expect(
      (
        service as unknown as {
          setSyncTokens: (syncToken: string, paginationToken?: string) => Promise<void>
        }
      ).setSyncTokens('new-sync-token', 'new-pagination-token'),
    ).rejects.toBe(writeError)

    expect(storage.setValuesAtomicallyAndAwaitPersist).toHaveBeenCalledTimes(1)
    expect(storage.values[StorageKeySyncPositionCheckpoint]).toEqual({
      version: 1,
      revision: 1,
      syncToken: 'old-sync-token',
    })
    expect(
      (
        service as unknown as {
          syncPositionCheckpoint?: { syncToken?: string; paginationToken?: string }
        }
      ).syncPositionCheckpoint,
    ).toEqual({
      version: 1,
      revision: 1,
      syncToken: 'old-sync-token',
    })
  })

  it('performs a full HTTP sync on websocket (re)connect to backfill', async () => {
    const service = createService('base-token')
    const syncSpy = jest.spyOn(service, 'sync').mockResolvedValue(undefined)

    await service.handleEvent({ type: WebSocketsServiceEvent.WebSocketDidOpen } as never)

    expect(syncSpy).toHaveBeenCalledTimes(1)
    expect(syncSpy).toHaveBeenCalledWith(expect.objectContaining({ sourceDescription: 'WebSocket reconnect backfill' }))
  })
})

describe('SyncService manual sync mode gating', () => {
  let logger: jest.Mocked<LoggerInterface>

  const createService = (): SyncService => {
    logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as jest.Mocked<LoggerInterface>

    const noop = () => undefined

    return new SyncService(
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
  }

  it('defaults to automatic mode (manual mode off)', () => {
    const service = createService()
    expect(service.isManualSyncModeEnabled()).toBe(false)
  })

  it('reflects the manual mode flag after setManualSyncMode', () => {
    const service = createService()
    service.setManualSyncMode(true)
    expect(service.isManualSyncModeEnabled()).toBe(true)
    service.setManualSyncMode(false)
    expect(service.isManualSyncModeEnabled()).toBe(false)
  })

  describe('shouldSuppressAutomaticSync', () => {
    it('never suppresses anything while in automatic (default) mode', () => {
      const service = createService()
      for (const source of Object.values(SyncSource) as SyncSource[]) {
        expect(service.shouldSuppressAutomaticSync({ source })).toBe(false)
      }
    })

    it('suppresses ambient automatic sources when manual mode is on', () => {
      const service = createService()
      service.setManualSyncMode(true)

      expect(service.shouldSuppressAutomaticSync({ source: SyncSource.External })).toBe(true)
      expect(service.shouldSuppressAutomaticSync({ source: SyncSource.NetworkReturned })).toBe(true)
      expect(service.shouldSuppressAutomaticSync({ source: SyncSource.BackoffRetry })).toBe(true)
    })

    it('never suppresses an explicit user-initiated sync, even in manual mode', () => {
      const service = createService()
      service.setManualSyncMode(true)

      expect(service.shouldSuppressAutomaticSync({ source: SyncSource.External, isUserInitiated: true })).toBe(false)
    })

    it('never suppresses continuation sources of an in-flight sync, even in manual mode', () => {
      const service = createService()
      service.setManualSyncMode(true)

      const continuations = [
        SyncSource.ResolveQueue,
        SyncSource.SpawnQueue,
        SyncSource.MoreDirtyItems,
        SyncSource.DownloadFirst,
        SyncSource.AfterDownloadFirst,
        SyncSource.IntegrityCheck,
        SyncSource.ResolveOutOfSync,
      ]
      for (const source of continuations) {
        expect(service.shouldSuppressAutomaticSync({ source })).toBe(false)
      }
    })
  })

  it('sync() short-circuits (no performSync) for a suppressed automatic source in manual mode', async () => {
    const service = createService()
    ;(service as unknown as { databaseLoaded: boolean }).databaseLoaded = true
    const performSync = jest.fn().mockResolvedValue(undefined)
    ;(service as unknown as { performSync: unknown }).performSync = performSync

    service.setManualSyncMode(true)
    await service.sync({ source: SyncSource.External })

    expect(performSync).not.toHaveBeenCalled()
  })

  it('sync() still runs an explicit user-initiated sync in manual mode', async () => {
    const service = createService()
    ;(service as unknown as { databaseLoaded: boolean }).databaseLoaded = true
    const performSync = jest.fn().mockResolvedValue(undefined)
    ;(service as unknown as { performSync: unknown }).performSync = performSync

    service.setManualSyncMode(true)
    await service.sync({ source: SyncSource.External, isUserInitiated: true })

    expect(performSync).toHaveBeenCalledTimes(1)
  })

  it('sync() runs normally for an automatic source when manual mode is OFF (auto mode unchanged)', async () => {
    const service = createService()
    ;(service as unknown as { databaseLoaded: boolean }).databaseLoaded = true
    const performSync = jest.fn().mockResolvedValue(undefined)
    ;(service as unknown as { performSync: unknown }).performSync = performSync

    await service.sync({ source: SyncSource.External })

    expect(performSync).toHaveBeenCalledTimes(1)
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

describe('SyncService local-only PERSISTENCE (silent data-loss regression)', () => {
  /**
   * These tests guard the actual bug that shipped green: a dirty local-only item was excluded
   * INSIDE itemsNeedingSync, so the SAME filtered set fed both the local persist path and the
   * upload path in prepareForSync — the item never reached persistPayloads and was lost on reload.
   * The pure-filter tests above never exercised persistence, which is why the bug was invisible.
   *
   * The invariant now is: prepareForSync PERSISTS local-only items (so they survive reloads) but
   * EXCLUDES them from the returned upload set (so they never leave the device). Both the online
   * and offline sync paths consume that single returned upload set with no re-derivation, so the
   * online/offline tests below drive performSync and assert what prepareForSyncExecution receives.
   */

  let logger: jest.Mocked<LoggerInterface>
  let getDirtyItems: jest.Mock
  let persistPayloads: jest.Mock
  let online: jest.Mock

  beforeAll(() => {
    SNLog.onError = jest.fn()
  })

  const LOCAL_ONLY_UUID = 'local-only-uuid'
  const NORMAL_UUID = 'normal-uuid'
  const DELETED_UUID = 'deleted-uuid'

  /**
   * Minimal dirty item shaped for the persist/upload derivation: itemsNeedingSync inspects
   * `payload` (lite check), `localOnly` and the backoff service; prepareForSync reads
   * `neverSynced`, `payload.deleted` (never-synced-deleted filter) and `payloadRepresentation()`
   * (the payload that reaches persistPayloads). A plain object content is non-lite and decrypted.
   */
  const makeDirtyItem = (uuid: string, localOnly: boolean, deleted = false) => {
    const payload = {
      uuid,
      deleted,
      dirty: true,
      dirtyIndex: 1,
      content: deleted ? undefined : { title: uuid },
    }
    return {
      uuid,
      localOnly,
      neverSynced: false,
      payload,
      payloadRepresentation: () => payload,
    } as unknown as DecryptedItemInterface
  }

  const createService = (dirtyItems: DecryptedItemInterface[]): SyncService => {
    logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as jest.Mocked<LoggerInterface>

    const noop = () => undefined

    getDirtyItems = jest.fn().mockReturnValue(dirtyItems)
    online = jest.fn().mockReturnValue(true)
    persistPayloads = jest.fn().mockResolvedValue(undefined)

    const itemManager = {
      getDirtyItems,
      findItem: jest.fn(),
      getCollection: jest.fn(),
    }
    const sessionManager = {
      online,
      isCurrentSessionReadOnly: jest.fn().mockReturnValue(false),
    }
    const syncFrequencyGuard = {
      isSyncCallsThresholdReachedThisMinute: jest.fn().mockReturnValue(false),
    }
    const syncBackoffService = {
      isItemInBackoff: jest.fn().mockReturnValue(false),
    }

    const service = new SyncService(
      itemManager as never,
      sessionManager as never,
      {} as never,
      { savePayloads: persistPayloads } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      'test-identifier',
      {} as never,
      logger,
      {} as never,
      syncFrequencyGuard as never,
      syncBackoffService as never,
      { addEventHandler: noop } as never,
    )

    ;(service as unknown as { databaseLoaded: boolean }).databaseLoaded = true

    return service
  }

  const callPrepareForSync = (
    service: SyncService,
    options: Record<string, unknown> = {},
  ): Promise<{ items: DecryptedItemInterface[]; neverSyncedDeleted: DecryptedItemInterface[] }> =>
    (
      service as unknown as {
        prepareForSync: (o: Record<string, unknown>) => Promise<{
          items: DecryptedItemInterface[]
          neverSyncedDeleted: DecryptedItemInterface[]
        }>
      }
    ).prepareForSync(options)

  const persistedUuids = (): string[] => (persistPayloads.mock.calls[0][0] as { uuid: string }[]).map((p) => p.uuid)

  it('prepareForSync persists a dirty local-only item locally', async () => {
    const service = createService([makeDirtyItem(LOCAL_ONLY_UUID, true), makeDirtyItem(NORMAL_UUID, false)])

    await callPrepareForSync(service)

    expect(persistPayloads).toHaveBeenCalledTimes(1)
    // The local-only item MUST reach the local persist set (this is the reload-survival guarantee).
    expect(persistedUuids()).toContain(LOCAL_ONLY_UUID)
    expect(persistedUuids()).toContain(NORMAL_UUID)
  })

  it('prepareForSync excludes a local-only item from the returned upload set', async () => {
    const service = createService([makeDirtyItem(LOCAL_ONLY_UUID, true), makeDirtyItem(NORMAL_UUID, false)])

    const { items } = await callPrepareForSync(service)

    const uploadUuids = items.map((i) => i.uuid)
    expect(uploadUuids).not.toContain(LOCAL_ONLY_UUID)
    expect(uploadUuids).toContain(NORMAL_UUID)
  })

  it('reports a failed pre-sync save without rejecting background sync, retains dirty state, and retries', async () => {
    const localOnly = makeDirtyItem(LOCAL_ONLY_UUID, true)
    const normal = makeDirtyItem(NORMAL_UUID, false)
    const service = createService([localOnly, normal])
    const quota = new Error('The quota has been exceeded.')
    quota.name = 'QuotaExceededError'
    persistPayloads.mockRejectedValueOnce(quota).mockResolvedValueOnce(undefined)

    await expect(service.sync({ source: SyncSource.External })).resolves.toBeUndefined()

    expect(localOnly.payload.dirty).toBe(true)
    expect(normal.payload.dirty).toBe(true)
    expect((service as unknown as { dirtyIndexAtLastPresyncSave?: number }).dirtyIndexAtLastPresyncSave).toBeUndefined()
    expect((service as unknown as { syncLock: symbol | false }).syncLock).toBe(false)

    await expect(callPrepareForSync(service)).resolves.toBeDefined()

    expect(persistPayloads).toHaveBeenCalledTimes(2)
    const retriedUuids = (persistPayloads.mock.calls[1][0] as { uuid: string }[]).map((payload) => payload.uuid)
    expect(retriedUuids).toEqual(expect.arrayContaining([LOCAL_ONLY_UUID, NORMAL_UUID]))
    expect((service as unknown as { dirtyIndexAtLastPresyncSave?: number }).dirtyIndexAtLastPresyncSave).toBeDefined()
  })

  it('rejects a failed acknowledged pre-sync save so the component caller can report save-error', async () => {
    const service = createService([makeDirtyItem(NORMAL_UUID, false)])
    const quota = new Error('The quota has been exceeded.')
    quota.name = 'QuotaExceededError'
    const onPresyncSave = jest.fn()
    persistPayloads.mockRejectedValueOnce(quota)

    await expect(service.sync({ source: SyncSource.External, onPresyncSave })).rejects.toBe(quota)

    expect(onPresyncSave).not.toHaveBeenCalled()
    expect((service as unknown as { syncLock: symbol | false }).syncLock).toBe(false)
  })

  it('a deleted item still flows to the upload/delete set (deletions must propagate)', async () => {
    const service = createService([makeDirtyItem(DELETED_UUID, false, true), makeDirtyItem(NORMAL_UUID, false)])

    const { items } = await callPrepareForSync(service)

    expect(items.map((i) => i.uuid)).toContain(DELETED_UUID)
  })

  it('does not advance the pre-sync watermark when a DownloadFirst key lookup failure is suppressed', async () => {
    const item = makeDirtyItem(NORMAL_UUID, false)
    const service = createService([item])
    const keyError = new Error('Cannot find items key to use for encryption')
    persistPayloads.mockRejectedValueOnce(keyError).mockResolvedValueOnce(undefined)

    await expect(callPrepareForSync(service, { mode: SyncMode.DownloadFirst })).resolves.toBeDefined()

    expect((service as unknown as { dirtyIndexAtLastPresyncSave?: number }).dirtyIndexAtLastPresyncSave).toBeUndefined()

    await expect(callPrepareForSync(service, { mode: SyncMode.DownloadFirst })).resolves.toBeDefined()

    expect(persistPayloads).toHaveBeenCalledTimes(2)
    expect((persistPayloads.mock.calls[1][0] as { uuid: string }[]).map((payload) => payload.uuid)).toContain(
      NORMAL_UUID,
    )
    expect((service as unknown as { dirtyIndexAtLastPresyncSave?: number }).dirtyIndexAtLastPresyncSave).toBeDefined()
  })

  /**
   * Drives performSync just far enough to capture the upload set handed to the execution seam,
   * then throws a sentinel from the (overridden) prepareForSyncExecution so we never make a real
   * request. prepareForSyncExecution is called OUTSIDE performSync's try/catch, so the sentinel
   * propagates out and we assert on the captured values.
   */
  const captureUploadSetViaPerformSync = async (service: SyncService): Promise<DecryptedItemInterface[]> => {
    let capturedUploadItems: DecryptedItemInterface[] = []
    const sentinel = new Error('stop-after-capture')
    ;(service as unknown as { prepareForSyncExecution: unknown }).prepareForSyncExecution = (
      items: DecryptedItemInterface[],
    ) => {
      capturedUploadItems = items
      throw sentinel
    }

    await expect(
      (service as unknown as { performSync: (o: Record<string, unknown>) => Promise<unknown> }).performSync({}),
    ).rejects.toBe(sentinel)

    return capturedUploadItems
  }

  it('ONLINE path: persists the local-only item but never hands it to the upload execution seam', async () => {
    const service = createService([makeDirtyItem(LOCAL_ONLY_UUID, true), makeDirtyItem(NORMAL_UUID, false)])
    online.mockReturnValue(true)

    const uploadItems = await captureUploadSetViaPerformSync(service)

    expect(persistedUuids()).toContain(LOCAL_ONLY_UUID)
    expect(uploadItems.map((i) => i.uuid)).not.toContain(LOCAL_ONLY_UUID)
    expect(uploadItems.map((i) => i.uuid)).toContain(NORMAL_UUID)
  })

  it('OFFLINE path: persists the local-only item but never hands it to the upload execution seam', async () => {
    const service = createService([makeDirtyItem(LOCAL_ONLY_UUID, true), makeDirtyItem(NORMAL_UUID, false)])
    online.mockReturnValue(false)

    const uploadItems = await captureUploadSetViaPerformSync(service)

    expect(persistedUuids()).toContain(LOCAL_ONLY_UUID)
    expect(uploadItems.map((i) => i.uuid)).not.toContain(LOCAL_ONLY_UUID)
    expect(uploadItems.map((i) => i.uuid)).toContain(NORMAL_UUID)
  })
})

describe('SyncService sync lock ownership', () => {
  const createService = (): SyncService => {
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as jest.Mocked<LoggerInterface>
    const noop = () => undefined

    const service = new SyncService(
      {} as never,
      {
        isCurrentSessionReadOnly: jest.fn().mockReturnValue(false),
        online: jest.fn().mockReturnValue(true),
      } as never,
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
      { isSyncCallsThresholdReachedThisMinute: jest.fn().mockReturnValue(false) } as never,
      {} as never,
      { addEventHandler: noop } as never,
    )

    ;(service as unknown as { databaseLoaded: boolean }).databaseLoaded = true
    ;(service as unknown as { opStatus: { syncInProgress: boolean } }).opStatus = {
      syncInProgress: false,
    } as never
    return service
  }

  it('does not let a concurrent LocalOnly request release an HTTP preparation lock it does not own', async () => {
    const service = createService()
    const configureSyncLock = (
      service as unknown as {
        configureSyncLock: (options: { source: SyncSource }) => {
          shouldExecuteSync: boolean
          releaseLock: () => void
        }
      }
    ).configureSyncLock.bind(service)
    const performSync = (
      service as unknown as {
        performSync: (options: { source: SyncSource; mode: SyncMode }) => Promise<unknown>
      }
    ).performSync.bind(service)
    const owner = configureSyncLock({ source: SyncSource.External })
    const ownerToken = (service as unknown as { syncLock: symbol | false }).syncLock
    const prepareForSync = jest.fn()
    const deferSyncRequest = jest.fn().mockResolvedValue('deferred')
    ;(service as unknown as { prepareForSync: jest.Mock }).prepareForSync = prepareForSync
    ;(service as unknown as { deferSyncRequest: jest.Mock }).deferSyncRequest = deferSyncRequest

    expect(owner.shouldExecuteSync).toBe(true)
    expect(typeof ownerToken).toBe('symbol')

    await expect(performSync({ source: SyncSource.External, mode: SyncMode.LocalOnly })).resolves.toEqual('deferred')

    expect(prepareForSync).not.toHaveBeenCalled()
    expect(deferSyncRequest).toHaveBeenCalledTimes(1)
    expect((service as unknown as { syncLock: symbol | false }).syncLock).toBe(ownerToken)

    owner.releaseLock()
    expect((service as unknown as { syncLock: symbol | false }).syncLock).toBe(false)
  })

  it('releases its lock when prepareForSync rejects', async () => {
    const service = createService()
    const prepareError = new Error('pre-sync encryption failed')
    ;(service as unknown as { prepareForSync: jest.Mock }).prepareForSync = jest.fn().mockRejectedValue(prepareError)

    await expect(
      (
        service as unknown as {
          performSync: (options: { source: SyncSource }) => Promise<unknown>
        }
      ).performSync({ source: SyncSource.External }),
    ).rejects.toBe(prepareError)

    expect((service as unknown as { syncLock: symbol | false }).syncLock).toBe(false)
  })

  it('settles a concurrent queued caller when the owner pre-sync persistence fails', async () => {
    SNLog.onError = jest.fn()
    const service = createService()
    const write = createDeferred<void>()
    const writeStarted = createDeferred<void>()
    const quota = new Error('The quota has been exceeded.')
    quota.name = 'QuotaExceededError'
    const payload = new DecryptedPayload<NoteContent>({
      uuid: 'queued-pre-sync-write',
      content_type: ContentType.TYPES.Note,
      content: FillItemContent<NoteContent>({ title: 'Queued', text: 'body' }),
      dirty: true,
      dirtyIndex: getIncrementedDirtyIndex(),
      ...PayloadTimestampDefaults(),
    })
    ;(service as unknown as { storageService: unknown }).storageService = {
      savePayloads: jest.fn(() => {
        writeStarted.resolve()
        return write.promise
      }),
    }
    ;(service as unknown as { opStatus: unknown }).opStatus = {
      syncInProgress: false,
      setDidEnd: jest.fn(),
      setError: jest.fn(),
    }
    ;(service as unknown as { notifyEvent: jest.Mock }).notifyEvent = jest.fn().mockResolvedValue(undefined)
    ;(service as unknown as { prepareForSync: jest.Mock }).prepareForSync = jest.fn(async () => {
      await service.persistPayloads([payload])
      return {
        items: [],
        beginDate: new Date(),
        frozenDirtyIndex: getCurrentDirtyIndex(),
        neverSyncedDeleted: [],
        localOnlyPersistedItems: [],
      }
    })

    const owner = service.sync({ source: SyncSource.External })
    await writeStarted.promise
    const queued = service.sync({ source: SyncSource.External })

    write.reject(quota)

    await expect(Promise.all([owner, queued])).resolves.toEqual([undefined, undefined])
    expect((service as unknown as { resolveQueue: unknown[] }).resolveQueue).toHaveLength(0)
    expect((service as unknown as { spawnQueue: unknown[] }).spawnQueue).toHaveLength(0)
    expect((service as unknown as { syncLock: symbol | false }).syncLock).toBe(false)
  })

  it('ends opStatus after an online persistence failure and allows the next sync to execute', async () => {
    SNLog.onError = jest.fn()
    const service = createService()
    const quota = new Error('The quota has been exceeded.')
    quota.name = 'QuotaExceededError'
    const payload = new DecryptedPayload<NoteContent>({
      uuid: 'operation-write-failure',
      content_type: ContentType.TYPES.Note,
      content: FillItemContent<NoteContent>({ title: 'Operation', text: 'body' }),
      ...PayloadTimestampDefaults(),
    })
    const savePayloads = jest.fn().mockRejectedValueOnce(quota).mockResolvedValueOnce(undefined)
    ;(service as unknown as { storageService: unknown }).storageService = { savePayloads }

    const status = {
      syncInProgress: false,
      setDidBegin: jest.fn(() => {
        status.syncInProgress = true
      }),
      setDidEnd: jest.fn(() => {
        status.syncInProgress = false
      }),
      setError: jest.fn(),
    }
    ;(service as unknown as { opStatus: unknown }).opStatus = status
    ;(service as unknown as { prepareForSync: jest.Mock }).prepareForSync = jest.fn().mockResolvedValue({
      items: [],
      beginDate: new Date(),
      frozenDirtyIndex: getCurrentDirtyIndex(),
      neverSyncedDeleted: [],
      localOnlyPersistedItems: [],
    })
    ;(service as unknown as { prepareForSyncExecution: jest.Mock }).prepareForSyncExecution = jest.fn(
      async (_items: unknown[], inTimeResolveQueue: unknown[]) => {
        status.setDidBegin()
        const resolveQueue = (service as unknown as { resolveQueue: unknown[] }).resolveQueue
        for (const request of inTimeResolveQueue) {
          const index = resolveQueue.indexOf(request)
          if (index >= 0) {
            resolveQueue.splice(index, 1)
          }
        }
        return []
      },
    )
    const run = jest.fn(() => service.persistPayloads([payload]))
    ;(service as unknown as { createSyncOperation: jest.Mock }).createSyncOperation = jest.fn().mockResolvedValue({
      operation: { run, numberOfItemsInvolved: 0 },
      mode: SyncMode.Default,
    })
    ;(service as unknown as { handleSyncOperationFinish: jest.Mock }).handleSyncOperationFinish = jest.fn(async () => {
      status.setDidEnd()
      return { hasError: false }
    })
    ;(
      service as unknown as { potentiallySyncAgainAfterSyncCompletion: jest.Mock }
    ).potentiallySyncAgainAfterSyncCompletion = jest.fn().mockResolvedValue(false)
    ;(service as unknown as { applyOnlineSyncResult: jest.Mock }).applyOnlineSyncResult = jest.fn()
    ;(service as unknown as { notifyEvent: jest.Mock }).notifyEvent = jest.fn().mockResolvedValue(undefined)
    ;(service as unknown as { notifyEventSync: jest.Mock }).notifyEventSync = jest.fn().mockResolvedValue(undefined)

    await expect(service.sync({ source: SyncSource.External })).resolves.toBeUndefined()
    expect(status.syncInProgress).toBe(false)
    expect(status.setDidEnd).toHaveBeenCalledTimes(1)
    await expect(
      (service as unknown as { currentSyncRequestPromise: Promise<void> }).currentSyncRequestPromise,
    ).resolves.toBeUndefined()

    await expect(service.sync({ source: SyncSource.External })).resolves.toBeUndefined()
    expect(run).toHaveBeenCalledTimes(2)
    expect(status.syncInProgress).toBe(false)
  })

  it('settles a caller queued behind an operation that finishes with a server error', async () => {
    const service = createService()
    const runDeferred = createDeferred<void>()
    const runStarted = createDeferred<void>()
    const status = {
      syncInProgress: false,
      setDidBegin: jest.fn(() => {
        status.syncInProgress = true
      }),
      setDidEnd: jest.fn(() => {
        status.syncInProgress = false
      }),
    }
    ;(service as unknown as { opStatus: unknown }).opStatus = status
    ;(service as unknown as { prepareForSync: jest.Mock }).prepareForSync = jest.fn().mockResolvedValue({
      items: [],
      beginDate: new Date(),
      frozenDirtyIndex: getCurrentDirtyIndex(),
      neverSyncedDeleted: [],
      localOnlyPersistedItems: [],
    })
    ;(service as unknown as { prepareForSyncExecution: jest.Mock }).prepareForSyncExecution = jest.fn(
      async (_items: unknown[], inTimeResolveQueue: unknown[]) => {
        status.setDidBegin()
        const resolveQueue = (service as unknown as { resolveQueue: unknown[] }).resolveQueue
        for (const request of inTimeResolveQueue) {
          const index = resolveQueue.indexOf(request)
          if (index >= 0) {
            resolveQueue.splice(index, 1)
          }
        }
        return []
      },
    )
    const run = jest.fn(() => {
      runStarted.resolve()
      return runDeferred.promise
    })
    ;(service as unknown as { createSyncOperation: jest.Mock }).createSyncOperation = jest.fn().mockResolvedValue({
      operation: { run, numberOfItemsInvolved: 0 },
      mode: SyncMode.Default,
    })
    ;(service as unknown as { handleSyncOperationFinish: jest.Mock }).handleSyncOperationFinish = jest.fn(async () => {
      status.setDidEnd()
      return { hasError: true }
    })
    ;(service as unknown as { applyOnlineSyncResult: jest.Mock }).applyOnlineSyncResult = jest.fn()

    const owner = service.sync({ source: SyncSource.External })
    await runStarted.promise
    const queued = service.sync({ source: SyncSource.External })
    runDeferred.resolve()

    await expect(Promise.all([owner, queued])).resolves.toEqual([undefined, undefined])
    expect((service as unknown as { resolveQueue: unknown[] }).resolveQueue).toHaveLength(0)
    expect((service as unknown as { spawnQueue: unknown[] }).spawnQueue).toHaveLength(0)
    expect((service as unknown as { syncLock: symbol | false }).syncLock).toBe(false)
  })
})

describe('SyncService cold-load STREAMING (large-vault OOM fix)', () => {
  let uuidCounter = 0
  const nextUuid = () => `sync-stream-${uuidCounter++}`

  /**
   * A minimal already-decrypted, non-note payload so the load loop's decryptSplit
   * is a pass-through and the lite-strip is a no-op. We only care about WHICH device
   * reads happen (keyed/per-chunk) vs. an all-at-once read.
   */
  const makeEntry = (content_type = ContentType.TYPES.Component) => ({
    uuid: nextUuid(),
    content_type,
    content: { foo: 'bar' },
    ...PayloadTimestampDefaults(),
  })

  const createService = (
    device: Record<string, unknown>,
    options: Record<string, unknown> = {},
    storageContextCurrent = true,
  ): SyncService => {
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as jest.Mocked<LoggerInterface>
    const noop = () => undefined

    const encryptionService = { decryptSplit: jest.fn().mockResolvedValue([]) }
    const payloadManager = { emitPayloads: jest.fn().mockResolvedValue(undefined) }
    const opStatus = { setDatabaseLoadStatus: jest.fn() }
    const storageService = {
      getValue: jest.fn().mockReturnValue([]),
      isStorageContextCurrent: jest.fn().mockResolvedValue(storageContextCurrent),
    }

    const service = new SyncService(
      {} as never, // itemManager
      {} as never, // sessionManager
      encryptionService as never,
      storageService as never, // storageService
      payloadManager as never,
      {} as never, // apiService
      {} as never, // historyService
      device as never,
      'test-identifier',
      { loadBatchSize: 2, sleepBetweenBatches: 0, ...options } as never,
      logger,
      {} as never, // sockets
      {} as never, // syncFrequencyGuard
      {} as never, // syncBackoffService
      { addEventHandler: noop, publish: noop, publishSync: noop } as never,
    )
    ;(service as unknown as { opStatus: unknown }).opStatus = opStatus
    return service
  }

  it('refuses to read database chunks when the storage context is stale or incomplete', async () => {
    const device = {
      getDatabaseLoadChunks: jest.fn(),
      getDatabaseEntries: jest.fn(),
    }
    const service = createService(device, {}, false)

    await expect(service.loadDatabasePayloads()).rejects.toThrow('stale or incomplete storage context')

    expect(device.getDatabaseLoadChunks).not.toHaveBeenCalled()
    expect(device.getDatabaseEntries).not.toHaveBeenCalled()
    expect(service.isDatabaseLoaded()).toBe(false)
  })

  it('STREAMS: never reads the whole DB at once; fetches each chunk by keys on demand', async () => {
    // Five regular entries spread across keyed chunks (batchSize 2 -> 3 chunks),
    // plus a single items-key entry that must be available up front.
    const itemsKeyEntry = makeEntry(ContentType.TYPES.ItemsKey)
    const regular = [makeEntry(), makeEntry(), makeEntry(), makeEntry(), makeEntry()]
    const byKey: Record<string, unknown> = {}
    for (const e of [itemsKeyEntry, ...regular]) {
      byKey[e.uuid] = e
    }

    const chunkKeys = [
      regular.slice(0, 2).map((e) => e.uuid),
      regular.slice(2, 4).map((e) => e.uuid),
      regular.slice(4, 5).map((e) => e.uuid),
    ]

    const getDatabaseEntries = jest
      .fn()
      .mockImplementation(async (_id: string, keys: string[]) => keys.map((k) => byKey[k]).filter(Boolean))

    // If the load ever falls back to an all-at-once read, fail loudly.
    const getAllDatabaseEntries = jest.fn(() => {
      throw new Error('getAllDatabaseEntries must NOT be called on the streaming cold-load path')
    })

    const device = {
      getDatabaseEntries,
      getAllDatabaseEntries,
      getDatabaseLoadChunks: jest.fn().mockResolvedValue({
        keys: {
          itemsKeys: { keys: [itemsKeyEntry.uuid] },
          keySystemRootKeys: { keys: [] },
          keySystemItemsKeys: { keys: [] },
          remainingChunks: chunkKeys.map((keys) => ({ keys })),
        },
        remainingChunksItemCount: regular.length,
      }),
    }

    const service = createService(device)

    await service.loadDatabasePayloads()

    expect(getAllDatabaseEntries).not.toHaveBeenCalled()
    // items-keys fetched up front, then one keyed read per remaining chunk.
    expect(getDatabaseEntries).toHaveBeenCalledWith('test-identifier', [itemsKeyEntry.uuid])
    for (const keys of chunkKeys) {
      expect(getDatabaseEntries).toHaveBeenCalledWith('test-identifier', keys)
    }
    // No read ever asked for more than one batch (loadBatchSize) of entry bodies at once.
    for (const call of getDatabaseEntries.mock.calls) {
      expect((call[1] as string[]).length).toBeLessThanOrEqual(2)
    }
    expect(service.isDatabaseLoaded()).toBe(true)
  })
})

describe('SyncService lazy-decrypt SAFETY INVARIANTS', () => {
  let uuidCounter = 0
  const nextUuid = () => `sync-lite-${uuidCounter++}`

  const createNotePayload = (overrides: Partial<NoteContent> = {}) =>
    new DecryptedPayload<NoteContent>(
      {
        uuid: nextUuid(),
        content_type: ContentType.TYPES.Note,
        content: FillItemContent<NoteContent>({ title: 'T', text: 'BODY-MUST-NOT-LEAK', ...overrides }),
        ...PayloadTimestampDefaults(),
      },
      PayloadSource.Constructor,
    )

  const createService = (options: Record<string, unknown>, deps: Record<string, unknown> = {}): SyncService => {
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as jest.Mocked<LoggerInterface>
    const noop = () => undefined

    return new SyncService(
      (deps.itemManager ?? {}) as never, // itemManager
      {} as never, // sessionManager
      (deps.encryptionService ?? {}) as never,
      (deps.storageService ?? {}) as never, // storageService
      (deps.payloadManager ?? {}) as never, // payloadManager
      {} as never, // apiService
      {} as never, // historyService
      (deps.device ?? {}) as never,
      'test-identifier',
      options as never,
      logger,
      {} as never, // sockets
      {} as never, // syncFrequencyGuard
      {} as never, // syncBackoffService
      { addEventHandler: noop } as never,
    )
  }

  const stripBodies = (service: SyncService, payloads: unknown[]) =>
    (
      service as unknown as { maybeStripBodiesForLazyDecrypt: (p: unknown[]) => unknown[] }
    ).maybeStripBodiesForLazyDecrypt(payloads)

  describe('cold-load body strip (maybeStripBodiesForLazyDecrypt)', () => {
    it('with the flag OFF, is a byte-identical pass-through (no lite payloads created)', () => {
      const service = createService({ lazyDecryptEnabled: false })
      const note = createNotePayload()

      const result = stripBodies(service, [note]) as DecryptedPayload<NoteContent>[]

      expect(result[0]).toBe(note)
      expect(isLitePayload(result[0])).toBe(false)
      expect(result[0].content.text).toEqual('BODY-MUST-NOT-LEAK')
    })

    it('with the flag ON, strips note bodies into lite payloads (text discarded, metadata kept)', () => {
      const service = createService({ lazyDecryptEnabled: true })
      const note = createNotePayload({ title: 'Keep Me', preview_plain: 'kept' })

      const result = stripBodies(service, [note]) as DecryptedPayload<NoteContent>[]

      expect(isLitePayload(result[0])).toBe(true)
      expect(result[0].content.text).toBeUndefined()
      expect(result[0].content.title).toEqual('Keep Me')
      expect(result[0].content.preview_plain).toEqual('kept')
      expect(result[0].dirty).not.toBe(true)
    })

    it('with the flag ON, produces ALL notes in a batch as lite (none dropped or deduped)', () => {
      const service = createService({ lazyDecryptEnabled: true })
      const notes = Array.from({ length: 1000 }, (_, i) => createNotePayload({ title: `note-${i}` }))

      const result = stripBodies(service, notes) as DecryptedPayload<NoteContent>[]

      // Every input note must appear in the output exactly once, all lite, in order.
      expect(result).toHaveLength(notes.length)
      expect(new Set(result.map((p) => p.uuid)).size).toEqual(notes.length)
      result.forEach((p, i) => {
        expect(isLitePayload(p)).toBe(true)
        expect(p.uuid).toEqual(notes[i].uuid)
        expect(p.content_type).toEqual(ContentType.TYPES.Note)
        expect(p.content.text).toBeUndefined()
      })
    })

    it('BUG-1: if stripping ONE note throws, that note falls back to FULL and the rest still load', () => {
      const service = createService({ lazyDecryptEnabled: true })

      const good1 = createNotePayload({ title: 'good-1' })
      const good2 = createNotePayload({ title: 'good-2' })

      // A payload whose ejected() throws simulates an unexpected content shape that
      // would otherwise abort the entire batch (and every subsequent batch).
      const poison = createNotePayload({ title: 'poison' })
      ;(poison as unknown as { ejected: () => unknown }).ejected = () => {
        throw new Error('boom')
      }

      const result = stripBodies(service, [good1, poison, good2]) as DecryptedPayload<NoteContent>[]

      // No item is dropped: all three are emitted.
      expect(result).toHaveLength(3)
      expect(isLitePayload(result[0])).toBe(true)
      // The poison note falls back to the full payload rather than aborting the map.
      expect(result[1]).toBe(poison)
      expect(isLitePayload(result[2])).toBe(true)
    })
  })

  describe('pre-sync push guard (payloadsByPreparingForServer)', () => {
    const prepareForServer = (service: SyncService, payloads: unknown[]) =>
      (
        service as unknown as { payloadsByPreparingForServer: (p: unknown[]) => Promise<unknown> }
      ).payloadsByPreparingForServer(payloads)

    it('THROWS rather than encrypt/push a lite payload (prevents body-loss on the server)', async () => {
      const service = createService({ lazyDecryptEnabled: true })
      const lite = createLitePayloadFromDecrypted(createNotePayload())

      await expect(prepareForServer(service, [lite])).rejects.toBeInstanceOf(LitePayloadSafetyError)
    })

    it('does not throw for a normal full payload (guard is a no-op for non-lite)', async () => {
      const encryptionService = { encryptSplit: jest.fn().mockResolvedValue([]) }
      const service = createService({ lazyDecryptEnabled: true }, { encryptionService })
      const note = createNotePayload()

      // Should pass the guard and proceed to encryption (which we stub to an empty result).
      await expect(prepareForServer(service, [note])).resolves.toBeDefined()
    })
  })

  describe('re-hydration entry point (getFullContentPayload)', () => {
    it('returns the full decrypted payload (with body) by reading + decrypting from the device', async () => {
      const fullEncrypted = {
        uuid: 'abc',
        content_type: ContentType.TYPES.Note,
        content: '004:ciphertext',
        enc_item_key: 'k',
        items_key_id: 'ik',
        ...PayloadTimestampDefaults(),
      }
      const decryptedResult = createNotePayload({ title: 'Rehydrated' })

      const device = {
        getDatabaseEntries: jest.fn().mockResolvedValue([fullEncrypted]),
      }
      const encryptionService = {
        decryptSplit: jest.fn().mockResolvedValue([decryptedResult]),
      }

      const service = createService({ lazyDecryptEnabled: true }, { device, encryptionService })

      const result = await service.getFullContentPayload('abc')

      expect(device.getDatabaseEntries).toHaveBeenCalledWith('test-identifier', ['abc'])
      expect(result).toBeDefined()
      expect((result?.content as NoteContent).text).toEqual('BODY-MUST-NOT-LEAK')
      expect(isLitePayload(result)).toBe(false)
    })

    it('returns undefined when the item is not found on disk', async () => {
      const device = { getDatabaseEntries: jest.fn().mockResolvedValue([]) }
      const service = createService({ lazyDecryptEnabled: true }, { device })

      const result = await service.getFullContentPayload('missing')

      expect(result).toBeUndefined()
    })
  })

  describe('persistPayloads tripwire (never write a lite payload to disk)', () => {
    const persistPayloads = (service: SyncService, payloads: unknown[]) =>
      (service as unknown as { persistPayloads: (p: unknown[]) => Promise<unknown> }).persistPayloads(payloads)

    it('THROWS rather than save a lite payload (would overwrite real ciphertext with nothing)', async () => {
      const savePayloads = jest.fn().mockResolvedValue(undefined)
      const service = createService({ lazyDecryptEnabled: true }, { storageService: { savePayloads } })
      const lite = createLitePayloadFromDecrypted(createNotePayload())

      await expect(persistPayloads(service, [lite])).rejects.toBeInstanceOf(LitePayloadSafetyError)
      expect(savePayloads).not.toHaveBeenCalled()
    })

    it('saves a normal full payload (guard is a no-op for non-lite)', async () => {
      const savePayloads = jest.fn().mockResolvedValue(undefined)
      const service = createService({ lazyDecryptEnabled: true }, { storageService: { savePayloads } })
      const note = createNotePayload()

      await persistPayloads(service, [note])

      expect(savePayloads).toHaveBeenCalledTimes(1)
      expect(isLitePayload((savePayloads.mock.calls[0][0] as DecryptedPayload<NoteContent>[])[0])).toBe(false)
    })
  })

  describe('markAllItemsAsNeedingSyncAndPersist re-hydrates lite items (sign-in mergeLocal path)', () => {
    const callMarkAll = (service: SyncService) => service.markAllItemsAsNeedingSyncAndPersist()

    it('re-hydrates a lite note to FULL content before persisting (no body-stripped write)', async () => {
      const fullNote = createNotePayload({ title: 'Keep Me' })
      const liteNote = createLitePayloadFromDecrypted(fullNote)
      // sanity: the in-memory item really is body-stripped
      expect(isLitePayload(liteNote)).toBe(true)
      expect((liteNote.content as NoteContent).text).toBeUndefined()

      const emittedPayloads: DecryptedPayload<NoteContent>[] = []
      const savedPayloads: DecryptedPayload<NoteContent>[] = []

      const liteItem = { uuid: liteNote.uuid, payload: liteNote, dirty: false }
      const itemManager = {
        items: [liteItem],
        findItem: jest.fn().mockImplementation((uuid: string) => (uuid === liteNote.uuid ? liteItem : undefined)),
      }
      const payloadManager = {
        emitPayloads: jest.fn().mockImplementation((p: DecryptedPayload<NoteContent>[]) => {
          emittedPayloads.push(...p)
          return Promise.resolve(undefined)
        }),
      }
      const savePayloads = jest.fn().mockImplementation((p: DecryptedPayload<NoteContent>[]) => {
        savedPayloads.push(...p)
        return Promise.resolve(undefined)
      })

      const service = createService(
        { lazyDecryptEnabled: true },
        { itemManager, payloadManager, storageService: { savePayloads } },
      )
      // Stub the on-disk re-hydration to return the full payload for the lite item's uuid.
      jest
        .spyOn(service, 'getFullContentPayload')
        .mockImplementation((uuid: string) => Promise.resolve(uuid === fullNote.uuid ? fullNote : undefined))

      await callMarkAll(service)

      // No lite payload is ever emitted or persisted.
      for (const p of [...emittedPayloads, ...savedPayloads]) {
        expect(isLitePayload(p)).toBe(false)
      }
      // The persisted payload carries the FULL body, not the stripped one.
      expect(savedPayloads).toHaveLength(1)
      expect((savedPayloads[0].content as NoteContent).text).toEqual('BODY-MUST-NOT-LEAK')
      expect(savedPayloads[0].dirty).toBe(true)
    })

    it('SKIPS (does not persist) a lite item whose full content cannot be re-hydrated', async () => {
      const liteNote = createLitePayloadFromDecrypted(createNotePayload())

      const liteItem = { uuid: liteNote.uuid, payload: liteNote, dirty: false }
      const itemManager = {
        items: [liteItem],
        findItem: jest.fn().mockImplementation((uuid: string) => (uuid === liteNote.uuid ? liteItem : undefined)),
      }
      const payloadManager = { emitPayloads: jest.fn().mockResolvedValue(undefined) }
      const savePayloads = jest.fn().mockResolvedValue(undefined)

      const service = createService(
        { lazyDecryptEnabled: true },
        { itemManager, payloadManager, storageService: { savePayloads } },
      )
      // Re-hydration fails (e.g. waiting on key download): return undefined.
      jest.spyOn(service, 'getFullContentPayload').mockResolvedValue(undefined)

      await callMarkAll(service)

      // Nothing persisted: we must NEVER overwrite full on-disk ciphertext with a stripped payload.
      expect(savePayloads).not.toHaveBeenCalled()
      expect(payloadManager.emitPayloads).toHaveBeenCalledWith([], expect.anything())
    })
  })

  describe('prepareForSync: a stray dirty LITE item must not halt all syncing (FIX 2)', () => {
    const callPrepareForSync = (service: SyncService, options: Record<string, unknown> = {}) =>
      (service as unknown as { prepareForSync: (o: unknown) => Promise<unknown> }).prepareForSync(options)

    const buildService = (deps: {
      dirtyItems: unknown[]
      savePayloads: jest.Mock
      getFullContentPayload?: (uuid: string) => Promise<unknown>
    }) => {
      const itemManager = {
        getDirtyItems: jest.fn().mockReturnValue(deps.dirtyItems),
        findItem: jest.fn(),
      }
      const payloadManager = { emitPayloads: jest.fn().mockResolvedValue(undefined) }
      const syncBackoffService = { isItemInBackoff: jest.fn().mockReturnValue(false) }
      const service = createService(
        { lazyDecryptEnabled: true },
        { itemManager, payloadManager, syncBackoffService, storageService: { savePayloads: deps.savePayloads } },
      )
      // popPayloadsNeedingPreSyncSave returns the input as-is when no prior pre-sync save recorded.
      ;(service as unknown as { dirtyIndexAtLastPresyncSave: number | undefined }).dirtyIndexAtLastPresyncSave =
        undefined
      if (deps.getFullContentPayload) {
        jest.spyOn(service, 'getFullContentPayload').mockImplementation(deps.getFullContentPayload as never)
      }
      return service
    }

    it('does NOT throw/halt when a dirty lite item is present; re-hydrates its full body to persist', async () => {
      const fullNote = createNotePayload({ title: 'Edited Lite' })
      const liteNote = createLitePayloadFromDecrypted(fullNote)
      const dirtyLiteItem = {
        uuid: liteNote.uuid,
        payload: liteNote,
        dirty: true,
        neverSynced: false,
        payloadRepresentation: () => liteNote,
      }

      const savedPayloads: DecryptedPayload<NoteContent>[] = []
      const savePayloads = jest.fn().mockImplementation((p: DecryptedPayload<NoteContent>[]) => {
        savedPayloads.push(...p)
        return Promise.resolve(undefined)
      })

      const service = buildService({
        dirtyItems: [dirtyLiteItem],
        savePayloads,
        getFullContentPayload: (uuid) => Promise.resolve(uuid === fullNote.uuid ? fullNote : undefined),
      })

      // Must resolve (not throw) — one stray lite item cannot stall all syncing.
      await expect(callPrepareForSync(service)).resolves.toBeDefined()

      // The dirty lite item's FULL body was re-hydrated and persisted, never a stripped payload.
      expect(savedPayloads).toHaveLength(1)
      expect(isLitePayload(savedPayloads[0])).toBe(false)
      expect((savedPayloads[0].content as NoteContent).text).toEqual('BODY-MUST-NOT-LEAK')
    })

    it('does NOT throw/halt and SKIPS the persist when a dirty lite item cannot be re-hydrated', async () => {
      const liteNote = createLitePayloadFromDecrypted(createNotePayload())
      const dirtyLiteItem = {
        uuid: liteNote.uuid,
        payload: liteNote,
        dirty: true,
        neverSynced: false,
        payloadRepresentation: () => liteNote,
      }

      const savePayloads = jest.fn().mockResolvedValue(undefined)
      const service = buildService({
        dirtyItems: [dirtyLiteItem],
        savePayloads,
        getFullContentPayload: () => Promise.resolve(undefined),
      })

      await expect(callPrepareForSync(service)).resolves.toBeDefined()

      // No lite payload reaches persist (which would otherwise throw the tripwire and halt sync).
      expect(savePayloads).not.toHaveBeenCalled()
    })

    it('SYNC-S1: a dirty lite item reaches the UPLOAD set (server), carrying the body AND the dirty edit', async () => {
      /**
       * WHERE THE EDIT LIVES: a dirty lite item is a metadata-only edit applied to a body-stripped
       * item. The LATEST edit (here a new title) is in the IN-MEMORY lite payload; only `text` was
       * stripped and survives (unchanged) ON DISK. The uploaded payload must merge the in-memory
       * edit with the on-disk body — NOT just push the stale on-disk full payload.
       */
      const onDiskFull = createNotePayload({ title: 'STALE-ON-DISK-TITLE', text: 'BODY-MUST-NOT-LEAK' })
      // The in-memory lite payload: same uuid, body stripped, but carrying the latest metadata edit.
      const liteBase = createLitePayloadFromDecrypted(onDiskFull)
      const editedLite = new DecryptedPayload<NoteContent>(
        {
          ...liteBase.ejected(),
          content: { ...(liteBase.content as NoteContent), title: 'EDITED-IN-MEMORY' },
          dirty: true,
          dirtyIndex: 42,
        },
        liteBase.source,
      )
      expect(isLitePayload(editedLite)).toBe(true)
      expect((editedLite.content as NoteContent).text).toBeUndefined()

      const dirtyLiteItem = {
        uuid: editedLite.uuid,
        payload: editedLite,
        dirty: true,
        neverSynced: false,
        payloadRepresentation: () => editedLite,
      }

      // emitPayloads replaces the in-memory item; findItem then returns the emitted FULL item.
      let liveItem: { uuid: string; payload: DecryptedPayload<NoteContent>; payloadRepresentation: () => unknown } =
        dirtyLiteItem as never
      const emittedPayloads: DecryptedPayload<NoteContent>[] = []
      const payloadManager = {
        emitPayloads: jest.fn().mockImplementation((p: DecryptedPayload<NoteContent>[]) => {
          emittedPayloads.push(...p)
          liveItem = { uuid: p[0].uuid, payload: p[0], payloadRepresentation: () => p[0] }
          return Promise.resolve(undefined)
        }),
      }

      const savedPayloads: DecryptedPayload<NoteContent>[] = []
      const savePayloads = jest.fn().mockImplementation((p: DecryptedPayload<NoteContent>[]) => {
        savedPayloads.push(...p)
        return Promise.resolve(undefined)
      })

      const itemManager = {
        getDirtyItems: jest.fn().mockReturnValue([dirtyLiteItem]),
        findItem: jest.fn().mockImplementation((uuid: string) => (uuid === editedLite.uuid ? liveItem : undefined)),
      }
      const syncBackoffService = { isItemInBackoff: jest.fn().mockReturnValue(false) }
      const service = createService(
        { lazyDecryptEnabled: true },
        { itemManager, payloadManager, syncBackoffService, storageService: { savePayloads } },
      )
      ;(service as unknown as { dirtyIndexAtLastPresyncSave: number | undefined }).dirtyIndexAtLastPresyncSave =
        undefined
      jest
        .spyOn(service, 'getFullContentPayload')
        .mockImplementation((uuid: string) => Promise.resolve(uuid === onDiskFull.uuid ? onDiskFull : undefined))

      const result = (await callPrepareForSync(service)) as {
        items: { uuid: string; payloadRepresentation: () => DecryptedPayload<NoteContent> }[]
      }

      // CRUX: the dirty lite item must be in the UPLOAD set (returned `items`), not merely persisted.
      const uploaded = result.items.find((i) => i.uuid === editedLite.uuid)
      expect(uploaded).toBeDefined()
      const uploadedPayload = (
        uploaded as { payloadRepresentation: () => DecryptedPayload<NoteContent> }
      ).payloadRepresentation()
      // The uploaded payload carries the FULL body AND the user's dirty edit (not the stale disk title).
      expect(isLitePayload(uploadedPayload)).toBe(false)
      expect((uploadedPayload.content as NoteContent).text).toEqual('BODY-MUST-NOT-LEAK')
      expect((uploadedPayload.content as NoteContent).title).toEqual('EDITED-IN-MEMORY')
      expect(uploadedPayload.dirty).toBe(true)

      // The full payload was emitted into the collection (replacing the lite item) and persisted.
      expect(emittedPayloads).toHaveLength(1)
      expect(isLitePayload(emittedPayloads[0])).toBe(false)
      expect(isLitePayload(savedPayloads[0])).toBe(false)
      expect((savedPayloads[0].content as NoteContent).title).toEqual('EDITED-IN-MEMORY')
    })
  })

  describe('persistPayloads error classification (FIX 3: surface write/quota, suppress legacy-key)', () => {
    const persistPayloads = (service: SyncService, payloads: unknown[], options: { throwError: boolean }) =>
      (
        service as unknown as { persistPayloads: (p: unknown[], o: { throwError: boolean }) => Promise<unknown> }
      ).persistPayloads(payloads, options)

    beforeAll(() => {
      // persistPayloads routes surfaced errors through SNLog.error, whose sink is unset in tests.
      SNLog.onError = jest.fn()
    })

    const buildService = (rejection: unknown) => {
      const savePayloads = jest.fn().mockRejectedValue(rejection)
      const notifyEvent = jest.fn().mockResolvedValue(undefined)
      const service = createService({ lazyDecryptEnabled: true }, { storageService: { savePayloads } })
      ;(service as unknown as { notifyEvent: jest.Mock }).notifyEvent = notifyEvent
      return { service, notifyEvent, savePayloads }
    }

    it('SURFACES a QuotaExceededError even when throwError:false (must not silently drop unsaved data)', async () => {
      const quota = new Error('The quota has been exceeded.')
      quota.name = 'QuotaExceededError'
      const { service, notifyEvent } = buildService(quota)
      const note = createNotePayload()

      await expect(persistPayloads(service, [note], { throwError: false })).rejects.toBe(quota)

      expect(notifyEvent).toHaveBeenCalledTimes(1)
      const [event] = notifyEvent.mock.calls[0]
      expect(event).toEqual(SyncEvent.DatabaseWriteError)
    })

    it('SUPPRESSES the expected legacy key-not-found error when throwError:false (003 sign-in path)', async () => {
      const keyError = new Error('Cannot find items key to use for encryption')
      const { service, notifyEvent } = buildService(keyError)
      const note = createNotePayload()

      await persistPayloads(service, [note], { throwError: false })

      expect(notifyEvent).not.toHaveBeenCalled()
    })

    it('classifier surfaces a generic write failure and suppresses a no-root-key failure', () => {
      expect(SyncService.isSuppressibleKeyLookupError(new Error('disk write failed'))).toBe(false)
      expect(
        SyncService.isSuppressibleKeyLookupError(new Error('Attempting root key encryption with no root key')),
      ).toBe(true)
    })
  })
})

describe('SyncService no-session sync status (no-login "syncing" bug)', () => {
  let logger: jest.Mocked<LoggerInterface>

  const buildOpStatus = () => {
    const status = {
      syncing: false,
      syncInProgress: false,
      setDidBegin: jest.fn(),
      setDidEnd: jest.fn(),
      hasError: jest.fn().mockReturnValue(false),
      reset: jest.fn(),
      clearError: jest.fn(),
      setUploadStatus: jest.fn(),
      setDownloadStatus: jest.fn(),
    }
    // setDidBegin is the ONLY thing that should flip the server-sync status on.
    status.setDidBegin.mockImplementation(() => {
      status.syncing = true
      status.syncInProgress = true
    })
    return status
  }

  const createService = (online: boolean): { service: SyncService; opStatus: ReturnType<typeof buildOpStatus> } => {
    logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as jest.Mocked<LoggerInterface>
    const noop = () => undefined

    // A session manager that reports offline (no session) or online accordingly.
    const sessionManager = {
      online: jest.fn().mockReturnValue(online),
      isCurrentSessionReadOnly: jest.fn().mockReturnValue(false),
    }

    // Records whether any server request was attempted via the api service.
    const apiService = { getSession: jest.fn() }

    const offlineRun = jest.fn().mockResolvedValue(undefined)

    const service = new SyncService(
      {} as never, // itemManager
      sessionManager as never,
      {} as never, // encryptionService
      {} as never, // storageService
      {} as never, // payloadManager
      apiService as never,
      {} as never, // historyService
      {} as never, // device
      'test-identifier',
      {} as never, // options
      logger,
      {} as never, // sockets
      {} as never, // syncFrequencyGuard
      {} as never, // syncBackoffService
      { addEventHandler: noop, publish: noop, publishSync: noop } as never,
    )

    const opStatus = buildOpStatus()
    ;(service as unknown as { opStatus: unknown }).opStatus = opStatus

    // Stub the network-vs-local operation seam so we observe WHICH path runs without
    // needing the full encryption/payload machinery. createServerSyncOperation is what
    // performs a server request; createOfflineSyncOperation is local IndexedDB persist.
    const serverRun = jest.fn().mockResolvedValue(undefined)
    ;(service as unknown as { createServerSyncOperation: unknown }).createServerSyncOperation = jest
      .fn()
      .mockResolvedValue({ run: serverRun })
    ;(service as unknown as { getOnlineSyncParameters: unknown }).getOnlineSyncParameters = jest
      .fn()
      .mockResolvedValue({ uploadPayloads: [], syncMode: 0 })
    ;(service as unknown as { createOfflineSyncOperation: unknown }).createOfflineSyncOperation = jest
      .fn()
      .mockReturnValue({ run: offlineRun })
    ;(service as unknown as { handleSyncOperationFinish: unknown }).handleSyncOperationFinish = jest
      .fn()
      .mockResolvedValue({ hasError: false })
    ;(
      service as unknown as { potentiallySyncAgainAfterSyncCompletion: unknown }
    ).potentiallySyncAgainAfterSyncCompletion = jest.fn().mockResolvedValue(false)
    ;(service as unknown as { prepareForSync: unknown }).prepareForSync = jest
      .fn()
      .mockResolvedValue({ items: [], beginDate: new Date(), frozenDirtyIndex: 0, neverSyncedDeleted: [] })
    ;(service as unknown as { notifyEvent: unknown }).notifyEvent = jest.fn().mockResolvedValue(undefined)
    ;(service as unknown as { notifyEventSync: unknown }).notifyEventSync = jest.fn().mockResolvedValue(undefined)
    ;(service as unknown as { databaseLoaded: boolean }).databaseLoaded = true
    ;(service as unknown as { syncFrequencyGuard: unknown }).syncFrequencyGuard = {
      isSyncCallsThresholdReachedThisMinute: () => false,
      incrementCallsPerMinute: () => undefined,
    }
    ;(
      service as unknown as { resolvePendingSyncRequestsThatMadeItInTimeOfCurrentRequest: unknown }
    ).resolvePendingSyncRequestsThatMadeItInTimeOfCurrentRequest = jest.fn()

    return { service, opStatus }
  }

  it('FAILING-FIRST: with NO session, sync() does NOT enter server-syncing status and makes NO server request', async () => {
    const { service, opStatus } = createService(false)
    const createServerSyncOperation = (service as unknown as { createServerSyncOperation: jest.Mock })
      .createServerSyncOperation

    await service.sync({ source: SyncSource.External })

    // No server request was created/run.
    expect(createServerSyncOperation).not.toHaveBeenCalled()
    // The offline (local persistence) path ran instead.
    expect(
      (service as unknown as { createOfflineSyncOperation: jest.Mock }).createOfflineSyncOperation,
    ).toHaveBeenCalledTimes(1)
    // Crucially: the server-sync status was NEVER begun, so the UI won't show "syncing".
    expect(opStatus.setDidBegin).not.toHaveBeenCalled()
    expect(opStatus.syncInProgress).toBe(false)
  })

  it('WITH a session, behavior is unchanged: server request runs AND server-sync status begins', async () => {
    const { service, opStatus } = createService(true)
    const createServerSyncOperation = (service as unknown as { createServerSyncOperation: jest.Mock })
      .createServerSyncOperation

    await service.sync({ source: SyncSource.External })

    expect(createServerSyncOperation).toHaveBeenCalledTimes(1)
    expect(
      (service as unknown as { createOfflineSyncOperation: jest.Mock }).createOfflineSyncOperation,
    ).not.toHaveBeenCalled()
    // Online sync DOES enter the server-sync status (the legitimate "syncing" indicator).
    expect(opStatus.setDidBegin).toHaveBeenCalledTimes(1)
  })
})

describe('SyncService read-only session convergence', () => {
  it('performs one download pull, retains local dirty data, and does not recursively spawn empty uploads', async () => {
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as jest.Mocked<LoggerInterface>
    const noop = () => undefined
    const payload = new DecryptedPayload<NoteContent>(
      {
        uuid: 'read-only-dirty-note',
        content_type: ContentType.TYPES.Note,
        content: FillItemContent<NoteContent>({ title: 'Local edit', text: 'must remain dirty' }),
        dirty: true,
        dirtyIndex: getIncrementedDirtyIndex(),
        ...PayloadTimestampDefaults(),
      },
      PayloadSource.Constructor,
    )
    const dirtyItem = {
      uuid: payload.uuid,
      localOnly: false,
      neverSynced: false,
      payload,
      payloadRepresentation: () => payload,
    } as unknown as DecryptedItemInterface
    const itemManager = {
      getDirtyItems: jest.fn().mockReturnValue([dirtyItem]),
    }
    const sessionManager = {
      online: jest.fn().mockReturnValue(true),
      isCurrentSessionReadOnly: jest.fn().mockReturnValue(true),
    }
    const run = jest.fn().mockResolvedValue(undefined)

    const service = new SyncService(
      itemManager as never,
      sessionManager as never,
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
      { isSyncCallsThresholdReachedThisMinute: jest.fn().mockReturnValue(false) } as never,
      { isItemInBackoff: jest.fn().mockReturnValue(false) } as never,
      { addEventHandler: noop } as never,
    )

    const prepareForSyncExecution = jest.fn().mockResolvedValue([])
    const handleSyncOperationFinish = jest.fn().mockResolvedValue({ hasError: false })
    const syncAgainByHandlingNewDirtyItems = jest.fn().mockResolvedValue(undefined)
    const notifyEvent = jest.fn().mockResolvedValue(undefined)
    const notifyEventSync = jest.fn().mockResolvedValue(undefined)
    ;(service as unknown as { databaseLoaded: boolean }).databaseLoaded = true
    ;(service as unknown as { opStatus: { syncInProgress: boolean } }).opStatus = {
      syncInProgress: false,
    } as never
    ;(service as unknown as { prepareForSync: jest.Mock }).prepareForSync = jest.fn().mockResolvedValue({
      items: [dirtyItem],
      beginDate: new Date(),
      frozenDirtyIndex: getCurrentDirtyIndex(),
      neverSyncedDeleted: [],
      localOnlyPersistedItems: [],
    })
    ;(service as unknown as { prepareForSyncExecution: jest.Mock }).prepareForSyncExecution = prepareForSyncExecution
    ;(service as unknown as { createSyncOperation: jest.Mock }).createSyncOperation = jest.fn().mockResolvedValue({
      operation: { run, numberOfItemsInvolved: 0 },
      mode: SyncMode.DownloadFirst,
    })
    ;(service as unknown as { handleSyncOperationFinish: jest.Mock }).handleSyncOperationFinish =
      handleSyncOperationFinish
    ;(service as unknown as { syncAgainByHandlingNewDirtyItems: jest.Mock }).syncAgainByHandlingNewDirtyItems =
      syncAgainByHandlingNewDirtyItems
    ;(service as unknown as { notifyEvent: jest.Mock }).notifyEvent = notifyEvent
    ;(service as unknown as { notifyEventSync: jest.Mock }).notifyEventSync = notifyEventSync

    await expect(service.sync({ source: SyncSource.External })).resolves.toBeUndefined()

    expect(run).toHaveBeenCalledTimes(1)
    expect(prepareForSyncExecution).toHaveBeenCalledWith(
      [],
      expect.any(Array),
      expect.any(Date),
      expect.any(Number),
      true,
    )
    expect(handleSyncOperationFinish).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ source: SyncSource.External }),
      [],
      SyncMode.DownloadFirst,
      [],
      expect.any(Number),
      true,
    )
    expect(syncAgainByHandlingNewDirtyItems).not.toHaveBeenCalled()
    expect(payload.dirty).toBe(true)
    expect(service.completedOnlineDownloadFirstSync).toBe(true)
    expect(notifyEvent).toHaveBeenCalledWith(SyncEvent.DownloadFirstSyncCompleted)
    expect(notifyEventSync).not.toHaveBeenCalledWith(
      SyncEvent.SyncCompletedWithAllItemsUploadedAndDownloaded,
      expect.anything(),
    )
    expect((service as unknown as { syncLock: symbol | false }).syncLock).toBe(false)
  })

  it('drains a caller queued during read-only DownloadFirst without recursively retrying dirty uploads', async () => {
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as jest.Mocked<LoggerInterface>
    const noop = () => undefined
    const payload = new DecryptedPayload<NoteContent>({
      uuid: 'read-only-queued-note',
      content_type: ContentType.TYPES.Note,
      content: FillItemContent<NoteContent>({ title: 'Queued', text: 'must remain dirty' }),
      dirty: true,
      dirtyIndex: getIncrementedDirtyIndex(),
      ...PayloadTimestampDefaults(),
    })
    const dirtyItem = {
      uuid: payload.uuid,
      localOnly: false,
      neverSynced: false,
      payload,
      payloadRepresentation: () => payload,
    } as unknown as DecryptedItemInterface
    const status = {
      syncInProgress: false,
      setDidBegin: jest.fn(() => {
        status.syncInProgress = true
      }),
      setDidEnd: jest.fn(() => {
        status.syncInProgress = false
      }),
    }
    const service = new SyncService(
      { getDirtyItems: jest.fn().mockReturnValue([dirtyItem]) } as never,
      {
        online: jest.fn().mockReturnValue(true),
        isCurrentSessionReadOnly: jest.fn().mockReturnValue(true),
      } as never,
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
      { isSyncCallsThresholdReachedThisMinute: jest.fn().mockReturnValue(false) } as never,
      { isItemInBackoff: jest.fn().mockReturnValue(false) } as never,
      { addEventHandler: noop } as never,
    )
    ;(service as unknown as { databaseLoaded: boolean }).databaseLoaded = true
    ;(service as unknown as { opStatus: unknown }).opStatus = status
    ;(service as unknown as { prepareForSync: jest.Mock }).prepareForSync = jest.fn().mockResolvedValue({
      items: [dirtyItem],
      beginDate: new Date(),
      frozenDirtyIndex: getCurrentDirtyIndex(),
      neverSyncedDeleted: [],
      localOnlyPersistedItems: [],
    })
    ;(service as unknown as { prepareForSyncExecution: jest.Mock }).prepareForSyncExecution = jest.fn(
      async (_items: unknown[], inTimeResolveQueue: unknown[]) => {
        status.setDidBegin()
        const resolveQueue = (service as unknown as { resolveQueue: unknown[] }).resolveQueue
        for (const request of inTimeResolveQueue) {
          const index = resolveQueue.indexOf(request)
          if (index >= 0) {
            resolveQueue.splice(index, 1)
          }
        }
        return []
      },
    )
    const firstRun = createDeferred<void>()
    const firstRunStarted = createDeferred<void>()
    const run = jest
      .fn()
      .mockImplementationOnce(() => {
        firstRunStarted.resolve()
        return firstRun.promise
      })
      .mockResolvedValueOnce(undefined)
    let operationCount = 0
    ;(service as unknown as { createSyncOperation: jest.Mock }).createSyncOperation = jest.fn(async () => {
      const mode = operationCount++ === 0 ? SyncMode.DownloadFirst : SyncMode.Default
      return { operation: { run, numberOfItemsInvolved: 0 }, mode }
    })
    ;(service as unknown as { handleSyncOperationFinish: jest.Mock }).handleSyncOperationFinish = jest.fn(async () => {
      status.setDidEnd()
      return { hasError: false }
    })
    ;(service as unknown as { applyOnlineSyncResult: jest.Mock }).applyOnlineSyncResult = jest.fn()
    ;(service as unknown as { notifyEvent: jest.Mock }).notifyEvent = jest.fn().mockResolvedValue(undefined)
    ;(service as unknown as { notifyEventSync: jest.Mock }).notifyEventSync = jest.fn().mockResolvedValue(undefined)

    const downloadFirst = service.sync({ source: SyncSource.External })
    await firstRunStarted.promise
    const queued = service.sync({ source: SyncSource.External })

    firstRun.resolve()

    await expect(Promise.all([downloadFirst, queued])).resolves.toEqual([undefined, undefined])
    expect(run).toHaveBeenCalledTimes(2)
    expect(payload.dirty).toBe(true)
    expect((service as unknown as { resolveQueue: unknown[] }).resolveQueue).toHaveLength(0)
    expect((service as unknown as { spawnQueue: unknown[] }).spawnQueue).toHaveLength(0)
    expect((service as unknown as { syncLock: symbol | false }).syncLock).toBe(false)
  })
})

describe('SyncService live-sync debounced immediate trigger', () => {
  let logger: jest.Mocked<LoggerInterface>

  const createService = (online: boolean, manualMode = false): SyncService => {
    logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as jest.Mocked<LoggerInterface>
    const noop = () => undefined

    const sessionManager = { online: jest.fn().mockReturnValue(online) }

    const service = new SyncService(
      {} as never, // itemManager
      sessionManager as never,
      {} as never, // encryptionService
      {} as never, // storageService
      {} as never, // payloadManager
      {} as never, // apiService
      {} as never, // historyService
      {} as never, // device
      'test-identifier',
      {} as never, // options
      logger,
      {} as never, // sockets
      {} as never, // syncFrequencyGuard
      {} as never, // syncBackoffService
      { addEventHandler: noop, publish: noop, publishSync: noop } as never,
    )
    if (manualMode) {
      service.setManualSyncMode(true)
    }
    return service
  }

  const dispatchItemsChanged = (service: SyncService) =>
    service.handleEvent({ type: WebSocketsServiceEvent.ItemsChangedOnServer } as never)

  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it('triggers a DEBOUNCED immediate sync after a server items-changed notification (with a session)', async () => {
    const service = createService(true)
    const syncSpy = jest.spyOn(service, 'sync').mockResolvedValue(undefined)

    await dispatchItemsChanged(service)

    // No immediate sync before the debounce elapses.
    expect(syncSpy).not.toHaveBeenCalled()

    jest.advanceTimersByTime(1_000)

    expect(syncSpy).toHaveBeenCalledTimes(1)
    expect(syncSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sourceDescription: 'Live Sync - Items Changed On Server' }),
    )
  })

  it('COALESCES a burst of notifications into a single debounced sync', async () => {
    const service = createService(true)
    const syncSpy = jest.spyOn(service, 'sync').mockResolvedValue(undefined)

    await dispatchItemsChanged(service)
    jest.advanceTimersByTime(300)
    await dispatchItemsChanged(service)
    jest.advanceTimersByTime(300)
    await dispatchItemsChanged(service)

    // Still nothing: the timer keeps resetting on each push within the window.
    expect(syncSpy).not.toHaveBeenCalled()

    jest.advanceTimersByTime(1_000)

    expect(syncSpy).toHaveBeenCalledTimes(1)
  })

  it('does NOT trigger an immediate sync when there is no session (backstop still flags the change)', async () => {
    const service = createService(false)
    const syncSpy = jest.spyOn(service, 'sync').mockResolvedValue(undefined)

    await dispatchItemsChanged(service)
    jest.advanceTimersByTime(5_000)

    expect(syncSpy).not.toHaveBeenCalled()
    // The 30s auto-sync backstop still sees the change.
    expect((service as unknown as { wasNotifiedOfItemsChangeOnServer: boolean }).wasNotifiedOfItemsChangeOnServer).toBe(
      true,
    )
  })

  it('does NOT trigger an immediate sync in manual sync mode (backstop will reconcile)', async () => {
    const service = createService(true, true)
    const syncSpy = jest.spyOn(service, 'sync').mockResolvedValue(undefined)

    await dispatchItemsChanged(service)
    jest.advanceTimersByTime(5_000)

    expect(syncSpy).not.toHaveBeenCalled()
  })
})

describe('SyncService cold-load COMPLETENESS (no silent partial loads)', () => {
  let uuidCounter = 0
  const nextUuid = () => `sync-complete-${uuidCounter++}`

  const makeEntry = (content_type = ContentType.TYPES.Component) => ({
    uuid: nextUuid(),
    content_type,
    content: { foo: 'bar' },
    ...PayloadTimestampDefaults(),
  })

  const createService = (
    device: Record<string, unknown>,
    options: Record<string, unknown> = {},
  ): { service: SyncService; logger: jest.Mocked<LoggerInterface> } => {
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as jest.Mocked<LoggerInterface>
    const noop = () => undefined

    const encryptionService = { decryptSplit: jest.fn().mockResolvedValue([]) }
    const payloadManager = { emitPayloads: jest.fn().mockResolvedValue(undefined) }
    const opStatus = { setDatabaseLoadStatus: jest.fn() }
    const storageService = {
      getValue: jest.fn().mockReturnValue([]),
      isStorageContextCurrent: jest.fn().mockResolvedValue(true),
    }

    const service = new SyncService(
      {} as never, // itemManager
      {} as never, // sessionManager
      encryptionService as never,
      storageService as never,
      payloadManager as never,
      {} as never, // apiService
      {} as never, // historyService
      device as never,
      'test-identifier',
      { loadBatchSize: 2, sleepBetweenBatches: 0, ...options } as never,
      logger,
      {} as never, // sockets
      {} as never, // syncFrequencyGuard
      {} as never, // syncBackoffService
      { addEventHandler: noop, publish: noop, publishSync: noop } as never,
    )
    ;(service as unknown as { opStatus: unknown }).opStatus = opStatus
    return { service, logger }
  }

  it('completes cleanly (no error log) when every chunk loads', async () => {
    const itemsKeyEntry = makeEntry(ContentType.TYPES.ItemsKey)
    const regular = [makeEntry(), makeEntry(), makeEntry(), makeEntry()]
    const byKey: Record<string, unknown> = {}
    for (const e of [itemsKeyEntry, ...regular]) {
      byKey[e.uuid] = e
    }
    const chunkKeys = [regular.slice(0, 2).map((e) => e.uuid), regular.slice(2, 4).map((e) => e.uuid)]

    const getDatabaseEntries = jest
      .fn()
      .mockImplementation(async (_id: string, keys: string[]) => keys.map((k) => byKey[k]).filter(Boolean))

    const device = {
      getDatabaseEntries,
      getDatabaseLoadChunks: jest.fn().mockResolvedValue({
        keys: {
          itemsKeys: { keys: [itemsKeyEntry.uuid] },
          keySystemRootKeys: { keys: [] },
          keySystemItemsKeys: { keys: [] },
          remainingChunks: chunkKeys.map((keys) => ({ keys })),
        },
        remainingChunksItemCount: regular.length,
      }),
    }

    const { service, logger } = createService(device)
    await service.loadDatabasePayloads()

    // No PARTIAL-load error was logged.
    const partialErrors = logger.error.mock.calls.filter((c) => String(c[0]).includes('PARTIAL load detected'))
    expect(partialErrors).toHaveLength(0)
    expect(service.isDatabaseLoaded()).toBe(true)
  })

  it('DETECTS a silently skipped batch: logs PARTIAL load and re-attempts the missing keys once', async () => {
    const itemsKeyEntry = makeEntry(ContentType.TYPES.ItemsKey)
    const regular = [makeEntry(), makeEntry(), makeEntry(), makeEntry()]
    const byKey: Record<string, unknown> = {}
    for (const e of [itemsKeyEntry, ...regular]) {
      byKey[e.uuid] = e
    }
    // Two regular chunks of 2 keys each; device reports 4 expected entries.
    const chunk0 = regular.slice(0, 2).map((e) => e.uuid)
    const chunk1 = regular.slice(2, 4).map((e) => e.uuid)

    const getDatabaseEntries = jest
      .fn()
      .mockImplementation(async (_id: string, keys: string[]) => keys.map((k) => byKey[k]).filter(Boolean))

    const device = {
      getDatabaseEntries,
      getDatabaseLoadChunks: jest.fn().mockResolvedValue({
        keys: {
          itemsKeys: { keys: [itemsKeyEntry.uuid] },
          keySystemRootKeys: { keys: [] },
          keySystemItemsKeys: { keys: [] },
          remainingChunks: [{ keys: chunk0 }, { keys: chunk1 }],
        },
        remainingChunksItemCount: regular.length,
      }),
    }

    const { service, logger } = createService(device)

    // Force the SECOND regular batch to be skipped (simulating a failed/dropped batch),
    // so only 2 of 4 expected entries are emitted.
    let batchCall = 0
    const realProcess = (
      service as unknown as { processPayloadBatch: (...a: unknown[]) => Promise<void> }
    ).processPayloadBatch.bind(service)
    ;(service as unknown as { processPayloadBatch: unknown }).processPayloadBatch = jest
      .fn()
      .mockImplementation(async (payloads: unknown[], pos?: number, count?: number) => {
        batchCall += 1
        // First call = chunk0 (succeeds); second call = chunk1 (throws -> skipped).
        // Third call = the completeness re-attempt of chunk1's keys (succeeds).
        if (batchCall === 2) {
          throw new Error('simulated dropped batch')
        }
        return realProcess(payloads, pos, count)
      })

    await service.loadDatabasePayloads()

    // The partial load must be detected and logged clearly.
    const partialErrors = logger.error.mock.calls.filter((c) => String(c[0]).includes('PARTIAL load detected'))
    expect(partialErrors).toHaveLength(1)

    // The missing keys (chunk1) were re-attempted exactly once via a keyed device read.
    expect(getDatabaseEntries).toHaveBeenCalledWith('test-identifier', chunk1)

    // Re-attempt recovered the entries, so a recovery (not residual-shortfall) was logged.
    const recovered = logger.debug.mock.calls.filter((c) => String(c[0]).includes('recovered the missing entries'))
    expect(recovered).toHaveLength(1)

    expect(service.isDatabaseLoaded()).toBe(true)
  })
})

/**
 * D4 (P0 data-loss regression): during paginated download, handleSuccessServerResponse
 * persists a page's retrieved items and THEN advances the persisted sync/pagination
 * token. If the persist silently fails (old behavior: savePayloads().catch swallowed the
 * error) the token advanced anyway, so the server never re-sends the failed page ->
 * permanent local loss. The fix makes the download-persist REJECT on a genuine
 * (non-suppressible) write failure so the token advance is skipped and the existing
 * sync() backoff re-pulls the page. A SUPPRESSIBLE legacy key-lookup error must still
 * NOT abort (003 sign-in self-heals after download-first sync).
 */
describe('SyncService D4: download-page persist failure must not advance the sync token', () => {
  let uuidCounter = 0
  const nextUuid = () => `sync-d4-${uuidCounter++}`

  const createNote = () =>
    new DecryptedPayload<NoteContent>(
      {
        uuid: nextUuid(),
        content_type: ContentType.TYPES.Note,
        content: FillItemContent<NoteContent>({ title: 'D4', text: 'body' }),
        ...PayloadTimestampDefaults(),
      },
      PayloadSource.Constructor,
    )

  beforeAll(() => {
    // persistPayloads routes surfaced errors through SNLog.error, whose sink is unset in tests.
    SNLog.onError = jest.fn()
  })

  const buildService = (savePayloadsRejection: unknown) => {
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as jest.Mocked<LoggerInterface>
    const noop = () => undefined

    const local = createNote().copy({
      dirty: true,
      dirtyIndex: getIncrementedDirtyIndex(),
      globalDirtyIndexAtLastSync: getCurrentDirtyIndex(),
    })
    const livePayloads = new Map<string, FullyFormedPayloadInterface>([[local.uuid, local]])
    const savePayloads = jest.fn().mockRejectedValue(savePayloadsRejection)
    const applyPayloads = async (payloads: FullyFormedPayloadInterface[]) => {
      for (const payload of payloads) {
        if (payload.deleted && !payload.dirty) {
          livePayloads.delete(payload.uuid)
        } else {
          livePayloads.set(payload.uuid, payload)
        }
      }
      return payloads
    }
    const emitDeltaEmit = jest
      .fn()
      .mockImplementation(async (emit: { emits: FullyFormedPayloadInterface[] }) => applyPayloads(emit.emits))
    const emitPayloads = jest.fn().mockImplementation(applyPayloads)
    const getMasterCollection = jest
      .fn()
      .mockImplementation(() => ImmutablePayloadCollection.WithPayloads([...livePayloads.values()]))
    const getHistoryMapCopy = jest.fn().mockReturnValue({})

    const service = new SyncService(
      {} as never, // itemManager
      {} as never, // sessionManager
      {} as never, // encryptionService
      { savePayloads } as never, // storageService
      { getMasterCollection, emitDeltaEmit, emitPayloads } as never, // payloadManager
      {} as never, // apiService
      { getHistoryMapCopy } as never, // historyService
      {} as never, // device
      'test-identifier',
      {} as never, // options
      logger,
      {} as never, // sockets
      {} as never, // syncFrequencyGuard
      {} as never, // syncBackoffService
      { addEventHandler: noop } as never,
    )

    ;(service as unknown as { opStatus: unknown }).opStatus = {
      clearError: jest.fn(),
      setError: jest.fn(),
      setDownloadStatus: jest.fn(),
      setUploadStatus: jest.fn(),
    }
    const notifyEvent = jest.fn().mockResolvedValue(undefined)
    ;(service as unknown as { notifyEvent: jest.Mock }).notifyEvent = notifyEvent
    ;(service as unknown as { notifyEventSync: jest.Mock }).notifyEventSync = jest.fn().mockResolvedValue(undefined)

    // Spy the logical cursor-pair setter independently of the storage backend.
    const setSyncTokens = jest
      .spyOn(service as unknown as { setSyncTokens: () => Promise<void> }, 'setSyncTokens')
      .mockResolvedValue(undefined)

    return { service, local, livePayloads, savePayloads, setSyncTokens, notifyEvent }
  }

  const buildResponse = (local?: FullyFormedPayloadInterface) => ({
    retrievedPayloads: [],
    savedPayloads: local
      ? [
          CreateServerSyncSavedPayload({
            ...local.ejected(),
            user_uuid: 'test-user',
          } as never),
        ]
      : [],
    conflicts: {},
    userEvents: [],
    asymmetricMessages: [],
    vaults: [],
    vaultInvites: [],
    lastSyncToken: 'server-token-NEXT',
    paginationToken: undefined,
    rawResponse: { data: {} },
  })

  const buildOperation = () => ({
    id: 'op-d4',
    payloadsSavedOrSaving: [],
    options: { sharedVaultUuids: undefined },
    payloads: [],
  })

  const invoke = (service: SyncService, operation: unknown, response: unknown) =>
    (
      service as unknown as { handleSuccessServerResponse: (o: unknown, r: unknown) => Promise<void> }
    ).handleSuccessServerResponse(operation, response)

  it('a genuine write failure (QuotaExceeded) REJECTS and does NOT advance the sync/pagination token', async () => {
    const quota = new Error('The quota has been exceeded.')
    quota.name = 'QuotaExceededError'
    const { service, local, livePayloads, setSyncTokens } = buildService(quota)

    await expect(invoke(service, buildOperation(), buildResponse(local))).rejects.toBe(quota)

    // The whole point: the persisted token must stay at its pre-failure position so the
    // failed page is re-pulled on the next sync, and the local dirty revision is restored.
    expect(setSyncTokens).not.toHaveBeenCalled()
    expect(livePayloads.get(local.uuid)).toBe(local)
    expect(livePayloads.get(local.uuid)?.dirty).toBe(true)
  })

  it('a SUPPRESSIBLE legacy key-lookup failure does NOT abort — the token still advances', async () => {
    const keyError = new Error('Cannot find items key to use for encryption')
    const { service, local, setSyncTokens } = buildService(keyError)

    await expect(invoke(service, buildOperation(), buildResponse(local))).resolves.toBeUndefined()

    expect(setSyncTokens).toHaveBeenCalledWith('server-token-NEXT', undefined)
  })
})

describe('SyncService offline persistence failure', () => {
  beforeAll(() => {
    SNLog.onError = jest.fn()
  })

  it('rejects the write and leaves the live payload dirty for retry', async () => {
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as jest.Mocked<LoggerInterface>
    const noop = () => undefined
    const dirty = new DecryptedPayload<NoteContent>(
      {
        uuid: 'offline-dirty-note',
        content_type: ContentType.TYPES.Note,
        content: FillItemContent<NoteContent>({ title: 'Unsaved', text: 'body' }),
        dirty: true,
        dirtyIndex: getIncrementedDirtyIndex(),
        ...PayloadTimestampDefaults(),
      },
      PayloadSource.Constructor,
    )
    let live: FullyFormedPayloadInterface = dirty
    const applyPayloads = async (payloads: FullyFormedPayloadInterface[]) => {
      live = payloads[0]
      return payloads
    }
    const emitDeltaEmit = jest
      .fn()
      .mockImplementation(async (emit: { emits: FullyFormedPayloadInterface[] }) => applyPayloads(emit.emits))
    const emitPayloads = jest.fn().mockImplementation(applyPayloads)
    const quota = new Error('The quota has been exceeded.')
    quota.name = 'QuotaExceededError'
    const savePayloads = jest.fn().mockRejectedValue(quota)

    const service = new SyncService(
      {} as never,
      {} as never,
      {} as never,
      { savePayloads } as never,
      {
        getMasterCollection: jest.fn().mockImplementation(() => ImmutablePayloadCollection.WithPayloads([live])),
        emitDeltaEmit,
        emitPayloads,
      } as never,
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
    ;(service as unknown as { opStatus: { clearError: jest.Mock } }).opStatus = {
      clearError: jest.fn(),
    } as never
    ;(service as unknown as { notifyEvent: jest.Mock }).notifyEvent = jest.fn().mockResolvedValue(undefined)

    const response = {
      savedPayloads: [CreateOfflineSyncSavedPayload(dirty)],
    }

    await expect(
      (
        service as unknown as {
          handleOfflineResponse: (response: unknown) => Promise<void>
        }
      ).handleOfflineResponse(response),
    ).rejects.toBe(quota)

    expect(savePayloads).toHaveBeenCalledTimes(1)
    expect(emitDeltaEmit).toHaveBeenCalledTimes(1)
    expect(emitPayloads).toHaveBeenCalledTimes(1)
    expect(live).toBe(dirty)
    expect(live.dirty).toBe(true)
  })
})

describe('SyncService local-only dirty-clear (infinite sync-loop regression — t54-e1)', () => {
  /**
   * REGRESSION GUARD for the hang t54-e1 found LIVE. Commit 55785604 made itemsNeedingSync() return
   * dirty local-only items (so prepareForSync persists them and they survive reload) but excludes
   * them from the UPLOAD set. Since only the upload/server-response path clears an item's dirty
   * flag, a dirty local-only item stayed dirty forever → itemsNeedingSync() was perpetually
   * non-empty → potentiallySyncAgainAfterSyncCompletion re-spawned sync() endlessly → sync() never
   * resolved (hung syncing app-wide). The 5 pure prepareForSync tests above shipped GREEN twice
   * without catching it because they never drive the re-sync loop.
   *
   * The fix clears the dirty flag LOCALLY at sync-finish (clearDirtyStateForPersistedLocalOnlyItems),
   * race-guarded on frozenDirtyIndex. These tests drive the REAL loop seam with a STATEFUL
   * itemManager fake (getDirtyItems reflects the emitted clean state) so:
   *  - a hang FAILS via a Promise.race timeout (it does not stall the whole runner),
   *  - the clear fires only for local-only items and is race-safe,
   *  - unmark-local-only still uploads.
   */

  const LOCAL_ONLY_UUID = 'loop-local-only-uuid'
  const NORMAL_UUID = 'loop-normal-uuid'

  beforeAll(() => {
    SNLog.onError = jest.fn()
  })

  type FakeItem = DecryptedItemInterface & { localOnly: boolean }

  const makeItem = (uuid: string, localOnly: boolean, dirtyIndex: number): FakeItem => {
    // A REAL DecryptedPayload so payload.ejected()/dirtyIndex/isLitePayload behave like production.
    const payload = new DecryptedPayload<NoteContent>(
      {
        uuid,
        content_type: ContentType.TYPES.Note,
        content: FillItemContent<NoteContent>({ title: uuid, text: `${uuid}-body` }),
        dirty: true,
        dirtyIndex,
        ...PayloadTimestampDefaults(),
      },
      PayloadSource.Constructor,
    )
    const item = {
      uuid,
      localOnly,
      neverSynced: false,
      payload,
      payloadRepresentation: () => item.payload,
    } as unknown as FakeItem
    return item
  }

  interface LoopHarness {
    service: SyncService
    dirtySet: Set<string>
    emitPayloads: jest.Mock
    persistPayloads: jest.Mock
    itemsNeedingSync: () => DecryptedItemInterface[]
    clearSeam: (items: DecryptedItemInterface[], frozenDirtyIndex: number) => Promise<void>
    prepareForSync: () => Promise<{
      items: DecryptedItemInterface[]
      localOnlyPersistedItems: DecryptedItemInterface[]
    }>
    potentiallySyncAgain: () => Promise<boolean>
    syncAgainSpy: jest.Mock
  }

  const buildHarness = (items: FakeItem[]): LoopHarness => {
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as jest.Mocked<LoggerInterface>
    const noop = () => undefined

    // The single source of truth for "still dirty". emitPayloads(dirty:false) drops the uuid, so
    // getDirtyItems()/itemsNeedingSync() reflect the clear — exactly what the live loop re-checks.
    const dirtySet = new Set(items.map((i) => i.uuid))

    const emitPayloads = jest.fn(async (payloads: FullyFormedPayloadInterface[]) => {
      for (const p of payloads) {
        const item = items.find((candidate) => candidate.uuid === p.uuid)
        if (item) {
          item.payload = p as DecryptedPayload<NoteContent>
        }
        if (p.dirty === false) {
          dirtySet.delete(p.uuid)
        } else if (p.dirty) {
          dirtySet.add(p.uuid)
        }
      }
      return payloads
    })
    const emitDeltaEmit = jest.fn(async (emit: { emits: FullyFormedPayloadInterface[] }) => emitPayloads(emit.emits))

    const itemManager = {
      getDirtyItems: jest.fn(() => items.filter((i) => dirtySet.has(i.uuid))),
      findItem: jest.fn((uuid: string) => items.find((i) => i.uuid === uuid)),
      getCollection: jest.fn(() => ({ findAll: () => [] })),
      findAnyItems: jest.fn(() => []),
    }
    const sessionManager = {
      online: jest.fn(() => false),
      isCurrentSessionReadOnly: jest.fn(() => false),
    }
    const syncFrequencyGuard = {
      isSyncCallsThresholdReachedThisMinute: jest.fn(() => false),
      incrementCallsPerMinute: jest.fn(),
    }
    const syncBackoffService = { isItemInBackoff: jest.fn(() => false) }
    const persistPayloads = jest.fn().mockResolvedValue(undefined)
    const payloadManager = {
      getMasterCollection: jest.fn(() =>
        ImmutablePayloadCollection.WithPayloads(items.map((item) => item.payload as FullyFormedPayloadInterface)),
      ),
      emitDeltaEmit,
      emitPayloads,
    }

    const service = new SyncService(
      itemManager as never,
      sessionManager as never,
      {} as never,
      { savePayloads: persistPayloads } as never,
      payloadManager as never,
      {} as never,
      {} as never,
      {} as never,
      'test-identifier',
      {} as never,
      logger,
      {} as never,
      syncFrequencyGuard as never,
      syncBackoffService as never,
      { addEventHandler: noop } as never,
    )

    const syncAgainSpy = jest.fn().mockResolvedValue(undefined)
    ;(service as unknown as { notifyEvent: unknown }).notifyEvent = jest.fn().mockResolvedValue(undefined)
    ;(service as unknown as { notifyEventSync: unknown }).notifyEventSync = jest.fn().mockResolvedValue(undefined)
    ;(service as unknown as { syncAgainByHandlingNewDirtyItems: unknown }).syncAgainByHandlingNewDirtyItems =
      syncAgainSpy
    ;(service as unknown as { createSyncOperation: unknown }).createSyncOperation = jest.fn().mockResolvedValue({
      operation: { run: async () => undefined, numberOfItemsInvolved: 0 },
      mode: SyncMode.Default,
    })
    ;(service as unknown as { databaseLoaded: boolean }).databaseLoaded = true
    ;(service as unknown as { syncLock: boolean }).syncLock = false
    ;(service as unknown as { opStatus: unknown }).opStatus = {
      syncInProgress: false,
      setDidBegin: jest.fn(),
      setDidEnd: jest.fn(),
      hasError: jest.fn(() => false),
      reset: jest.fn(),
      setError: jest.fn(),
    }

    const itemsNeedingSync = () =>
      (service as unknown as { itemsNeedingSync: () => DecryptedItemInterface[] }).itemsNeedingSync()
    const clearSeam = (toClear: DecryptedItemInterface[], frozenDirtyIndex: number) =>
      (
        service as unknown as {
          clearDirtyStateForPersistedLocalOnlyItems: (i: DecryptedItemInterface[], f: number) => Promise<void>
        }
      ).clearDirtyStateForPersistedLocalOnlyItems(toClear, frozenDirtyIndex)
    const prepareForSync = () =>
      (
        service as unknown as {
          prepareForSync: (o: Record<string, unknown>) => Promise<{
            items: DecryptedItemInterface[]
            localOnlyPersistedItems: DecryptedItemInterface[]
          }>
        }
      ).prepareForSync({})
    const potentiallySyncAgain = () =>
      (
        service as unknown as {
          potentiallySyncAgainAfterSyncCompletion: (
            m: SyncMode,
            o: Record<string, unknown>,
            q: unknown[],
            online: boolean,
          ) => Promise<boolean>
        }
      ).potentiallySyncAgainAfterSyncCompletion(SyncMode.Default, {}, [], false)

    return {
      service,
      dirtySet,
      emitPayloads,
      persistPayloads,
      itemsNeedingSync,
      clearSeam,
      prepareForSync,
      potentiallySyncAgain,
      syncAgainSpy,
    }
  }

  function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<T>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`sync() did not resolve within ${ms}ms — infinite sync-loop regression`)),
        ms,
      )
    })
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>
  }

  it('FULL DRIVE (offline): sync() RESOLVES for a dirty local-only note and stops re-selecting it (loop terminates)', async () => {
    const dirtyIndex = getIncrementedDirtyIndex()
    const localOnly = makeItem(LOCAL_ONLY_UUID, true, dirtyIndex)
    const h = buildHarness([localOnly])

    // Pre-condition: this is exactly the state that hung — the local-only item needs sync.
    expect(h.itemsNeedingSync().map((i) => i.uuid)).toEqual([LOCAL_ONLY_UUID])

    // A hang here FAILS the test via the race timeout instead of stalling the whole suite.
    await expect(withTimeout(h.service.sync({}), 3000)).resolves.toBeUndefined()

    // The loop terminated: the local-only item is no longer dirty / no longer re-selected.
    expect(h.dirtySet.has(LOCAL_ONLY_UUID)).toBe(false)
    expect(h.itemsNeedingSync()).toHaveLength(0)

    // Its dirty flag was cleared locally (emit + persist of a dirty:false copy).
    const clearedEmit = h.emitPayloads.mock.calls.find(([payloads]) =>
      (payloads as { uuid: string; dirty?: boolean }[]).some((p) => p.uuid === LOCAL_ONLY_UUID && p.dirty === false),
    )
    expect(clearedEmit).toBeDefined()
    const clearedPersist = h.persistPayloads.mock.calls.find(([payloads]) =>
      (payloads as { uuid: string; dirty?: boolean }[]).some((p) => p.uuid === LOCAL_ONLY_UUID && p.dirty === false),
    )
    expect(clearedPersist).toBeDefined()
  }, 8000)

  it('is the precise INVERSE of the loop: potentiallySyncAgain would re-spawn BEFORE the clear, and does NOT after', async () => {
    const dirtyIndex = getIncrementedDirtyIndex()
    const localOnly = makeItem(LOCAL_ONLY_UUID, true, dirtyIndex)
    const h = buildHarness([localOnly])

    // BEFORE the clear: the still-dirty local-only item makes the re-sync loop fire (returns true).
    expect(h.itemsNeedingSync().map((i) => i.uuid)).toEqual([LOCAL_ONLY_UUID])
    await expect(h.potentiallySyncAgain()).resolves.toBe(true)
    expect(h.syncAgainSpy).toHaveBeenCalledTimes(1)

    // Apply the local dirty-clear (frozenDirtyIndex >= the item's dirtyIndex → not re-dirtied).
    await h.clearSeam([localOnly], dirtyIndex)

    // AFTER the clear: itemsNeedingSync is empty and the loop does NOT re-spawn.
    expect(h.itemsNeedingSync()).toHaveLength(0)
    h.syncAgainSpy.mockClear()
    await expect(h.potentiallySyncAgain()).resolves.toBe(false)
    expect(h.syncAgainSpy).not.toHaveBeenCalled()
  })

  it('prepareForSync collects ONLY non-deleted local-only items into localOnlyPersistedItems (not normals)', async () => {
    const localOnly = makeItem(LOCAL_ONLY_UUID, true, getIncrementedDirtyIndex())
    const normal = makeItem(NORMAL_UUID, false, getIncrementedDirtyIndex())
    const h = buildHarness([localOnly, normal])

    const { items, localOnlyPersistedItems } = await h.prepareForSync()

    // The clear-seam feed carries the local-only item only …
    expect(localOnlyPersistedItems.map((i) => i.uuid)).toEqual([LOCAL_ONLY_UUID])
    // … and the normal item still goes to the upload set (never force-cleared locally).
    expect(items.map((i) => i.uuid)).toContain(NORMAL_UUID)
    expect(items.map((i) => i.uuid)).not.toContain(LOCAL_ONLY_UUID)
  })

  it('clear seam fires ONLY for the items it is given and NEVER touches a co-dirty normal item', async () => {
    const dirtyIndex = getIncrementedDirtyIndex()
    const localOnly = makeItem(LOCAL_ONLY_UUID, true, dirtyIndex)
    const normal = makeItem(NORMAL_UUID, false, dirtyIndex)
    const h = buildHarness([localOnly, normal])

    await h.clearSeam([localOnly], dirtyIndex)

    // Local-only cleared; the normal item is untouched by this seam (still dirty, no clean emit).
    expect(h.dirtySet.has(LOCAL_ONLY_UUID)).toBe(false)
    expect(h.dirtySet.has(NORMAL_UUID)).toBe(true)
    for (const [payloads] of h.emitPayloads.mock.calls) {
      for (const p of payloads as { uuid: string; dirty?: boolean }[]) {
        expect(p.uuid).not.toEqual(NORMAL_UUID)
      }
    }
  })

  it('RACE GUARD: does NOT clear a local-only item re-dirtied mid-sync (dirtyIndex advanced past frozenDirtyIndex)', async () => {
    const frozenDirtyIndex = getIncrementedDirtyIndex()
    // Simulate a concurrent edit that landed AFTER sync began: its dirtyIndex is past the snapshot.
    const reDirtied = makeItem(LOCAL_ONLY_UUID, true, frozenDirtyIndex + 1)
    const h = buildHarness([reDirtied])

    await h.clearSeam([reDirtied], frozenDirtyIndex)

    // The concurrent edit is preserved: item stays dirty, no clean emit/persist happened.
    expect(h.dirtySet.has(LOCAL_ONLY_UUID)).toBe(true)
    expect(h.emitPayloads).not.toHaveBeenCalled()
    expect(h.persistPayloads).not.toHaveBeenCalled()
    expect(h.itemsNeedingSync().map((i) => i.uuid)).toEqual([LOCAL_ONLY_UUID])
  })

  it('does not overwrite a local-only edit that lands while the clean payload is being persisted', async () => {
    const frozenDirtyIndex = getIncrementedDirtyIndex()
    const localOnly = makeItem(LOCAL_ONLY_UUID, true, frozenDirtyIndex)
    const h = buildHarness([localOnly])
    const write = createDeferred<void>()
    const writeStarted = createDeferred<void>()
    h.persistPayloads.mockImplementationOnce(() => {
      writeStarted.resolve()
      return write.promise
    })

    const clearPromise = h.clearSeam([localOnly], frozenDirtyIndex)
    await writeStarted.promise

    const newerPayload = new DecryptedPayload<NoteContent>({
      ...localOnly.payload.ejected(),
      content: FillItemContent<NoteContent>({ title: 'Newer edit', text: 'must survive' }),
      dirty: true,
      dirtyIndex: frozenDirtyIndex + 1,
    })
    localOnly.payload = newerPayload
    h.dirtySet.add(localOnly.uuid)

    write.resolve()
    await clearPromise

    expect(localOnly.payload).toBe(newerPayload)
    expect(localOnly.payload.dirty).toBe(true)
    expect(h.dirtySet.has(localOnly.uuid)).toBe(true)
  })

  it('restores the original dirty local-only payload when persisting its clean copy fails', async () => {
    const frozenDirtyIndex = getIncrementedDirtyIndex()
    const localOnly = makeItem(LOCAL_ONLY_UUID, true, frozenDirtyIndex)
    const originalPayload = localOnly.payload
    const h = buildHarness([localOnly])
    const quota = new Error('The quota has been exceeded.')
    quota.name = 'QuotaExceededError'
    h.persistPayloads.mockRejectedValueOnce(quota)

    await expect(h.clearSeam([localOnly], frozenDirtyIndex)).rejects.toBe(quota)

    expect(localOnly.payload).toBe(originalPayload)
    expect(localOnly.payload.dirty).toBe(true)
    expect(h.dirtySet.has(localOnly.uuid)).toBe(true)
  })

  it('UNMARK local-only: a no-longer-local-only item is NOT collected for local clear and IS returned for upload', async () => {
    // Toggling localOnly off re-dirties the item; excludeLocalOnlyItems no longer excludes it.
    const unmarked = makeItem(LOCAL_ONLY_UUID, false, getIncrementedDirtyIndex())
    const h = buildHarness([unmarked])

    const { items, localOnlyPersistedItems } = await h.prepareForSync()

    expect(localOnlyPersistedItems).toHaveLength(0)
    expect(items.map((i) => i.uuid)).toContain(LOCAL_ONLY_UUID)
  })
})

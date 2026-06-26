import { LoggerInterface } from '@standardnotes/utils'
import { SyncSource, WebSocketsServiceEvent } from '@standardnotes/services'
import { SyncService } from './SyncService'
import {
  DecryptedItemInterface,
  DecryptedPayload,
  DeletedItemInterface,
  FillItemContent,
  ImmutablePayloadCollection,
  LitePayloadSafetyError,
  NoteContent,
  PayloadSource,
  PayloadTimestampDefaults,
  createLitePayloadFromDecrypted,
  isLitePayload,
} from '@standardnotes/models'
import { ContentType } from '@standardnotes/domain-core'

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

describe('SyncService websocket push apply (Phase 1A)', () => {
  let logger: jest.Mocked<LoggerInterface>
  let storage: { values: Record<string, string>; getValue: jest.Mock; setValue: jest.Mock }
  let payloadManager: { getMasterCollection: jest.Mock; emitDeltaEmit: jest.Mock }
  let historyService: { getHistoryMapCopy: jest.Mock }
  let encryptionService: { decryptSplit: jest.Mock }

  const StorageKeyLastSyncToken = 'syncToken'

  const createService = (currentToken?: string): SyncService => {
    logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as jest.Mocked<LoggerInterface>

    const noop = () => undefined

    storage = {
      values: currentToken ? { [StorageKeyLastSyncToken]: currentToken } : {},
      getValue: jest.fn(),
      setValue: jest.fn(),
    }
    storage.getValue.mockImplementation((key: string) => storage.values[key])
    storage.setValue.mockImplementation((key: string, value: string) => {
      storage.values[key] = value
    })

    payloadManager = {
      getMasterCollection: jest.fn().mockReturnValue(ImmutablePayloadCollection.WithPayloads([])),
      emitDeltaEmit: jest.fn().mockResolvedValue([]),
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

  it('applies an in-order push directly without an HTTP sync and advances the token', async () => {
    const service = createService('base-token')
    const syncSpy = jest.spyOn(service, 'sync').mockResolvedValue(undefined)
    // The pushed items are decrypted/applied via the real pipeline; with no items
    // the resolver emits empty deltas and we just advance the token.
    ;(service as unknown as { persistPayloads: jest.Mock }).persistPayloads = jest.fn().mockResolvedValue(undefined)

    await dispatchPush(service, { items: [], syncToken: 'new-token', baseSyncToken: 'base-token' })

    expect(syncSpy).not.toHaveBeenCalled()
    expect(storage.values[StorageKeyLastSyncToken]).toEqual('new-token')
  })

  it('discards the push and triggers an HTTP sync on a token mismatch/gap', async () => {
    const service = createService('different-token')
    const syncSpy = jest.spyOn(service, 'sync').mockResolvedValue(undefined)

    await dispatchPush(service, { items: [], syncToken: 'new-token', baseSyncToken: 'base-token' })

    expect(syncSpy).toHaveBeenCalledTimes(1)
    // Token must NOT be advanced when we discard the push.
    expect(storage.values[StorageKeyLastSyncToken]).toEqual('different-token')
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
    expect(storage.values[StorageKeyLastSyncToken]).toEqual('base-token')
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
    expect(storage.values[StorageKeyLastSyncToken]).toEqual('base-token')
    expect(logger.error).toHaveBeenCalled()
  })

  it('performs a full HTTP sync on websocket (re)connect to backfill', async () => {
    const service = createService('base-token')
    const syncSpy = jest.spyOn(service, 'sync').mockResolvedValue(undefined)

    await service.handleEvent({ type: WebSocketsServiceEvent.WebSocketDidOpen } as never)

    expect(syncSpy).toHaveBeenCalledTimes(1)
    expect(syncSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sourceDescription: 'WebSocket reconnect backfill' }),
    )
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

  const createService = (device: Record<string, unknown>, options: Record<string, unknown> = {}): SyncService => {
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
    const storageService = { getValue: jest.fn().mockReturnValue([]) }

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
      {} as never, // itemManager
      {} as never, // sessionManager
      (deps.encryptionService ?? {}) as never,
      {} as never, // storageService
      {} as never, // payloadManager
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
})

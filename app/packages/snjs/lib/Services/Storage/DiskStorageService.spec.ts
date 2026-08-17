import { DiskStorageService } from './DiskStorageService'
import {
  InternalEventBus,
  DeviceInterface,
  InternalEventBusInterface,
  StoragePersistencePolicies,
} from '@standardnotes/services'
import { UuidGenerator } from '@standardnotes/utils'
import { SNLog } from '../../Log'

describe('diskStorageService', () => {
  let storageService: DiskStorageService
  let internalEventBus: InternalEventBusInterface
  let device: DeviceInterface

  beforeEach(() => {
    internalEventBus = {} as jest.Mocked<InternalEventBus>
    device = {} as jest.Mocked<DeviceInterface>

    storageService = new DiskStorageService(device, 'test', internalEventBus)
  })

  it('setInitialValues should set unwrapped values as wrapped value if wrapped value is not encrypted', async () => {
    storageService.isStorageWrapped = jest.fn().mockReturnValue(false)

    await storageService['setInitialValues']({
      wrapped: { content: { foo: 'bar' } } as never,
      nonwrapped: {},
      unwrapped: { bar: 'zoo' },
    })

    expect(storageService['values']).toEqual({
      wrapped: { content: { foo: 'bar' } } as never,
      nonwrapped: {},
      unwrapped: { bar: 'zoo', foo: 'bar' },
    })
  })

  describe('write serialization (mutex/queue)', () => {
    /**
     * A controllable deferred so a test can hold a device call "in flight" and
     * release it manually, letting us interleave overlapping operations and
     * prove they are forced to run strictly one after another.
     */
    type Deferred = { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void }

    const createDeferred = (): Deferred => {
      let resolve!: () => void
      let reject!: (e: unknown) => void
      const promise = new Promise<void>((res, rej) => {
        resolve = res
        reject = rej
      })
      return { promise, resolve, reject }
    }

    let order: string[]
    let pending: Deferred[]
    let mockEncryptionProvider: { hasRootKeyEncryptionSource: jest.Mock; encryptSplit: jest.Mock }

    // Records when a device write actually begins ('<tag>:start') and returns a
    // deferred promise so the caller controls when it finishes.
    const gatedDeviceCall = (tag: string) => {
      order.push(`${tag}:start`)
      const deferred = createDeferred()
      pending.push(deferred)
      return deferred.promise.then(() => {
        order.push(`${tag}:end`)
      })
    }

    beforeEach(() => {
      order = []
      pending = []

      mockEncryptionProvider = {
        hasRootKeyEncryptionSource: jest.fn().mockReturnValue(false),
        encryptSplit: jest.fn().mockResolvedValue([]),
      }
      storageService.provideEncryptionProvider(mockEncryptionProvider as never)

      // Give clearAllData/clearValues something to operate on.
      storageService['values'] = DiskStorageService.DefaultValuesObject()
      storageService['storagePersistable'] = true

      device.saveDatabaseEntries = jest.fn().mockImplementation(() => gatedDeviceCall('save'))
      device.removeDatabaseEntry = jest.fn().mockImplementation(() => gatedDeviceCall('delete'))
      device.removeAllDatabaseEntries = jest.fn().mockImplementation(() => gatedDeviceCall('clear'))
      device.getRawStorageValue = jest.fn().mockResolvedValue(undefined)
      device.setRawStorageValue = jest.fn().mockResolvedValue(undefined)
      device.removeRawStorageValue = jest.fn().mockResolvedValue(undefined)
    })

    const flush = () => new Promise((resolve) => setImmediate(resolve))

    it('serializes overlapping savePayloads, deletePayloads and clearAllData (no interleaving)', async () => {
      // Fire all three so they overlap. savePayloads performs an async encryption
      // preamble before it reaches the write queue, so we flush between calls to
      // make the enqueue order deterministic and equal to call order. The mutex
      // guarantee under test is that, regardless of order, no two writes are ever
      // in flight at once.
      const savePromise = storageService.savePayloads([])
      await flush()
      const deletePromise = storageService.deletePayloadsWithUuids(['uuid-1'])
      const clearPromise = storageService.clearAllPayloads()

      await flush()

      // Only the first write should have started; the others must wait.
      expect(order).toEqual(['save:start'])
      expect(pending).toHaveLength(1)

      // Release the save; the delete should then (and only then) start.
      pending[0].resolve()
      await flush()
      expect(order).toEqual(['save:start', 'save:end', 'delete:start'])

      // Release the delete; the clear should then start.
      pending[1].resolve()
      await flush()
      expect(order).toEqual(['save:start', 'save:end', 'delete:start', 'delete:end', 'clear:start'])

      // Release the clear.
      pending[2].resolve()
      await Promise.all([savePromise, deletePromise, clearPromise])

      expect(order).toEqual(['save:start', 'save:end', 'delete:start', 'delete:end', 'clear:start', 'clear:end'])
    })

    it('releases the queue for the next write when a prior write rejects', async () => {
      const savePromise = storageService.savePayloads([])
      await flush()
      const deletePromise = storageService.deletePayloadsWithUuids(['uuid-1'])

      await flush()
      expect(order).toEqual(['save:start'])

      // Reject the in-flight save. The delete must still proceed afterwards.
      const failure = new Error('quota exceeded')
      pending[0].reject(failure)

      await expect(savePromise).rejects.toThrow('quota exceeded')

      await flush()
      // The delete was unblocked despite the prior rejection.
      expect(order).toContain('delete:start')

      pending[1].resolve()
      await expect(deletePromise).resolves.toBeUndefined()
    })
  })

  /**
   * D2 (P0/P1 data-loss regression) for the key-value persist path:
   *  1. POISON: persistValuesToDisk awaits currentPersistPromise before reassigning it.
   *     If a prior write rejected, that promise stayed rejected and re-threw out of EVERY
   *     subsequent KV persist for the whole session (sync/session/root-key writes blocked).
   *  2. SWALLOW: setValue did `void persistValuesToDisk()`, dropping any rejection on the
   *     floor — a failed write left disk silently stale with no retry.
   */
  describe('D2: key-value persist must not poison or silently swallow', () => {
    const flush = () => new Promise((resolve) => setImmediate(resolve))

    beforeEach(() => {
      // generatePersistableValues() mints a UUID for the wrapped storage payload.
      UuidGenerator.SetGenerator(() => 'd2-test-uuid')
      storageService.provideEncryptionProvider({
        hasRootKeyEncryptionSource: jest.fn().mockReturnValue(false),
        encryptSplit: jest.fn().mockResolvedValue([]),
      } as never)
      storageService['values'] = DiskStorageService.DefaultValuesObject()
      storageService['storagePersistable'] = true
      device.getRawStorageValue = jest.fn().mockResolvedValue(undefined)
      device.setRawStorageValue = jest.fn().mockResolvedValue(undefined)
      device.removeRawStorageValue = jest.fn().mockResolvedValue(undefined)
      SNLog.onError = jest.fn()
    })

    it('a rejected persist does NOT poison subsequent key-value persists (de-poison currentPersistPromise)', async () => {
      device.setRawStorageValue = jest
        .fn()
        .mockRejectedValueOnce(new Error('quota exceeded'))
        .mockResolvedValue(undefined)

      // First critical write fails at the disk layer.
      await expect(storageService.setValueAndAwaitPersist('k1', 'v1')).rejects.toThrow('quota exceeded')

      // Before the fix, currentPersistPromise stayed a rejected promise and every later
      // persist re-threw it for the whole session. It must now proceed and succeed.
      await expect(storageService.setValueAndAwaitPersist('k2', 'v2')).resolves.toBeUndefined()
      expect(device.setRawStorageValue).toHaveBeenCalledTimes(2)
    })

    it('setValue no longer silently swallows a persist failure — it flags a retry and logs', async () => {
      device.setRawStorageValue = jest.fn().mockRejectedValueOnce(new Error('quota exceeded'))
      storageService['needsPersist'] = false

      storageService.setValue('k', 'v')
      await flush()

      // needsPersist drives a retry on the next persist / Launched_10 stage handler.
      expect(storageService['needsPersist']).toBe(true)
      expect(SNLog.onError).toHaveBeenCalled()
    })
  })

  describe('atomic key-value batches', () => {
    const flush = () => new Promise((resolve) => setImmediate(resolve))

    beforeEach(() => {
      UuidGenerator.SetGenerator(() => 'atomic-storage-test-uuid')
      storageService.provideEncryptionProvider({
        hasRootKeyEncryptionSource: jest.fn().mockReturnValue(false),
        encryptSplit: jest.fn().mockResolvedValue([]),
      } as never)
      storageService['values'] = DiskStorageService.DefaultValuesObject()
      storageService['storagePersistable'] = true
      device.getRawStorageValue = jest.fn().mockResolvedValue(undefined)
      device.setRawStorageValue = jest.fn().mockResolvedValue(undefined)
    })

    it('persists a cursor migration as one raw replacement', async () => {
      storageService['values'].unwrapped = {
        syncToken: 'legacy-sync-token',
        cursorToken: 'legacy-pagination-token',
      }
      const checkpoint = {
        version: 1,
        revision: 1,
        syncToken: 'legacy-sync-token',
        paginationToken: 'legacy-pagination-token',
      }

      await storageService.setValuesAtomicallyAndAwaitPersist({
        syncPositionCheckpoint: checkpoint,
        syncToken: undefined,
        cursorToken: undefined,
      })

      expect(device.setRawStorageValue).toHaveBeenCalledTimes(1)
      expect(storageService.getValue('syncPositionCheckpoint')).toEqual(checkpoint)
      expect(storageService.getValue('syncToken')).toBeUndefined()
      expect(storageService.getValue('cursorToken')).toBeUndefined()

      const persisted = JSON.parse((device.setRawStorageValue as jest.Mock).mock.calls[0][1]) as {
        wrapped: { content: Record<string, unknown> }
      }
      expect(persisted.wrapped.content).toEqual(expect.objectContaining({ syncPositionCheckpoint: checkpoint }))
    })

    it('restores every cached key after a rejected batch without a compensating write', async () => {
      const previousCheckpoint = {
        version: 1,
        revision: 4,
        syncToken: 'old-sync-token',
        paginationToken: 'old-pagination-token',
      }
      storageService['values'].unwrapped = {
        syncPositionCheckpoint: previousCheckpoint,
        syncToken: 'legacy-sync-token',
      }
      device.setRawStorageValue = jest.fn().mockRejectedValue(new Error('raw storage write failed'))

      await expect(
        storageService.setValuesAtomicallyAndAwaitPersist({
          syncPositionCheckpoint: {
            version: 1,
            revision: 5,
            syncToken: 'new-sync-token',
            paginationToken: 'new-pagination-token',
          },
          syncToken: undefined,
        }),
      ).rejects.toThrow('raw storage write failed')

      expect(device.setRawStorageValue).toHaveBeenCalledTimes(1)
      expect(storageService.getValue('syncPositionCheckpoint')).toBe(previousCheckpoint)
      expect(storageService.getValue('syncToken')).toBe('legacy-sync-token')
    })

    it('serializes atomic writers so a stale snapshot cannot land last', async () => {
      let releaseFirstWrite!: () => void
      const firstWrite = new Promise<void>((resolve) => {
        releaseFirstWrite = resolve
      })
      device.setRawStorageValue = jest
        .fn()
        .mockImplementationOnce(async () => firstWrite)
        .mockResolvedValueOnce(undefined)

      const firstCheckpoint = { version: 1, revision: 1, syncToken: 'first-token' }
      const secondCheckpoint = { version: 1, revision: 2, syncToken: 'second-token' }
      const first = storageService.setValuesAtomicallyAndAwaitPersist({
        syncPositionCheckpoint: firstCheckpoint,
      })
      await flush()

      const second = storageService.setValuesAtomicallyAndAwaitPersist({
        syncPositionCheckpoint: secondCheckpoint,
      })
      await flush()

      expect(device.setRawStorageValue).toHaveBeenCalledTimes(1)
      expect(storageService.getValue('syncPositionCheckpoint')).toEqual(firstCheckpoint)

      releaseFirstWrite()
      await Promise.all([first, second])

      expect(device.setRawStorageValue).toHaveBeenCalledTimes(2)
      const firstPersisted = JSON.parse((device.setRawStorageValue as jest.Mock).mock.calls[0][1]) as {
        wrapped: { content: Record<string, unknown> }
      }
      const secondPersisted = JSON.parse((device.setRawStorageValue as jest.Mock).mock.calls[1][1]) as {
        wrapped: { content: Record<string, unknown> }
      }
      expect(firstPersisted.wrapped.content.syncPositionCheckpoint).toEqual(firstCheckpoint)
      expect(secondPersisted.wrapped.content.syncPositionCheckpoint).toEqual(secondCheckpoint)
      expect(storageService.getValue('syncPositionCheckpoint')).toEqual(secondCheckpoint)
    })

    it('does not roll back a newer same-key mutation when an older atomic write fails', async () => {
      let rejectFirstWrite!: (error: Error) => void
      const firstWrite = new Promise<void>((_resolve, reject) => {
        rejectFirstWrite = reject
      })
      device.setRawStorageValue = jest
        .fn()
        .mockImplementationOnce(async () => firstWrite)
        .mockResolvedValueOnce(undefined)
      storageService['values'].unwrapped = {
        syncPositionCheckpoint: { version: 1, revision: 1, syncToken: 'old-token' },
      }

      const failedAtomicWrite = storageService.setValuesAtomicallyAndAwaitPersist({
        syncPositionCheckpoint: { version: 1, revision: 2, syncToken: 'failed-token' },
      })
      await flush()

      const newerCheckpoint = { version: 1, revision: 3, syncToken: 'newer-token' }
      storageService.setValue('syncPositionCheckpoint', newerCheckpoint)
      rejectFirstWrite(new Error('older write failed'))

      await expect(failedAtomicWrite).rejects.toThrow('older write failed')
      await storageService.awaitPersist()

      expect(device.setRawStorageValue).toHaveBeenCalledTimes(2)
      expect(storageService.getValue('syncPositionCheckpoint')).toEqual(newerCheckpoint)
      const persisted = JSON.parse((device.setRawStorageValue as jest.Mock).mock.calls[1][1]) as {
        wrapped: { content: Record<string, unknown> }
      }
      expect(persisted.wrapped.content.syncPositionCheckpoint).toEqual(newerCheckpoint)
    })

    it('a rejected forward write remains on the old checkpoint after a process boundary', async () => {
      let rawStorageValue: string | undefined
      device.getRawStorageValue = jest.fn().mockImplementation(async (key: string) => {
        return key === storageService['getPersistenceKey']() ? rawStorageValue : undefined
      })
      device.setRawStorageValue = jest.fn().mockImplementation(async (key: string, value: string) => {
        if (key === storageService['getPersistenceKey']()) {
          rawStorageValue = value
        }
      })

      const oldCheckpoint = { version: 1, revision: 8, syncToken: 'durable-old-token' }
      await storageService.setValuesAtomicallyAndAwaitPersist({
        syncPositionCheckpoint: oldCheckpoint,
      })
      const durableBeforeFailure = rawStorageValue

      ;(device.setRawStorageValue as jest.Mock).mockRejectedValueOnce(new Error('simulated process-boundary failure'))
      await expect(
        storageService.setValuesAtomicallyAndAwaitPersist({
          syncPositionCheckpoint: { version: 1, revision: 9, syncToken: 'non-durable-new-token' },
        }),
      ).rejects.toThrow('simulated process-boundary failure')

      expect(rawStorageValue).toBe(durableBeforeFailure)
      expect(storageService.getValue('syncPositionCheckpoint')).toEqual(oldCheckpoint)

      const restarted = new DiskStorageService(device, 'test', internalEventBus)
      restarted.provideEncryptionProvider({
        hasRootKeyEncryptionSource: jest.fn().mockReturnValue(false),
        encryptSplit: jest.fn().mockResolvedValue([]),
      } as never)
      await restarted.initializeFromDisk()

      expect(restarted.getValue('syncPositionCheckpoint')).toEqual(oldCheckpoint)

      const newCheckpoint = { version: 1, revision: 9, syncToken: 'durable-new-token' }
      await storageService.setValuesAtomicallyAndAwaitPersist({
        syncPositionCheckpoint: newCheckpoint,
      })

      const restartedAfterCommit = new DiskStorageService(device, 'test', internalEventBus)
      restartedAfterCommit.provideEncryptionProvider({
        hasRootKeyEncryptionSource: jest.fn().mockReturnValue(false),
        encryptSplit: jest.fn().mockResolvedValue([]),
      } as never)
      await restartedAfterCommit.initializeFromDisk()

      expect(restartedAfterCommit.getValue('syncPositionCheckpoint')).toEqual(newCheckpoint)
    })
  })

  describe('cross-instance storage-object mutation', () => {
    type Deferred = { promise: Promise<void>; resolve: () => void }

    const createDeferred = (): Deferred => {
      let resolve!: () => void
      const promise = new Promise<void>((res) => {
        resolve = res
      })
      return { promise, resolve }
    }

    const flush = () => new Promise((resolve) => setImmediate(resolve))

    let rawStorageValue: string | undefined
    let rawGenerationValue: string | undefined
    let sharedDevice: DeviceInterface
    const originalLockManager = navigator.locks

    const createService = async (encryptionProvider?: object) => {
      const service = new DiskStorageService(sharedDevice, 'shared-test', internalEventBus)
      service.provideEncryptionProvider(
        (encryptionProvider ?? {
          hasRootKeyEncryptionSource: jest.fn().mockReturnValue(false),
          encryptSplit: jest.fn().mockResolvedValue([]),
        }) as never,
      )
      await service.initializeFromDisk()
      service['storagePersistable'] = true
      return service
    }

    const persistedUnwrappedValues = () => {
      const persisted = JSON.parse(rawStorageValue as string) as {
        wrapped: { content?: Record<string, unknown> }
      }
      return persisted.wrapped.content ?? {}
    }

    const persistRawValue = (key: string, value: string) => {
      if (key.endsWith('-storage_object_generation')) {
        rawGenerationValue = value
      } else if (key.endsWith('-storage')) {
        rawStorageValue = value
      }
    }

    beforeEach(() => {
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: undefined,
      })
      UuidGenerator.SetGenerator(() => 'cross-instance-storage-test-uuid')
      rawStorageValue = undefined
      rawGenerationValue = undefined
      sharedDevice = {
        getRawStorageValue: jest.fn().mockImplementation(async (key: string) => {
          if (key.endsWith('-storage_object_generation')) {
            return rawGenerationValue
          }
          return key.endsWith('-storage') ? rawStorageValue : undefined
        }),
        setRawStorageValue: jest.fn().mockImplementation(async (key: string, value: string) => {
          persistRawValue(key, value)
        }),
        removeRawStorageValue: jest.fn().mockResolvedValue(undefined),
        removeRawStorageValuesForIdentifier: jest.fn().mockImplementation(async () => {
          rawStorageValue = undefined
          rawGenerationValue = undefined
        }),
        clearNamespacedKeychainValue: jest.fn().mockResolvedValue(undefined),
        getAllDatabaseEntries: jest.fn().mockResolvedValue([]),
        getDatabaseEntries: jest.fn().mockResolvedValue([]),
        removeAllDatabaseEntries: jest.fn().mockResolvedValue(undefined),
        saveDatabaseEntries: jest.fn().mockResolvedValue(undefined),
      } as never
    })

    afterEach(() => {
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: originalLockManager,
      })
    })

    it('fresh-merges independent keys from two stale instances while the first physical write is delayed', async () => {
      const firstService = await createService()
      const secondService = await createService()
      const firstWriteGate = createDeferred()

      ;(sharedDevice.setRawStorageValue as jest.Mock).mockImplementationOnce(async (key: string, value: string) => {
        await firstWriteGate.promise
        persistRawValue(key, value)
      })

      const firstWrite = firstService.setValueAndAwaitPersist('first-context', 'alpha')
      await flush()
      const secondWrite = secondService.setValueAndAwaitPersist('second-context', 'beta')
      await flush()

      expect(sharedDevice.setRawStorageValue).toHaveBeenCalledTimes(1)
      firstWriteGate.resolve()
      await Promise.all([firstWrite, secondWrite])

      expect(sharedDevice.setRawStorageValue).toHaveBeenCalledTimes(2)
      expect(persistedUnwrappedValues()).toEqual(
        expect.objectContaining({
          'first-context': 'alpha',
          'second-context': 'beta',
        }),
      )
    })

    it('decrypts the fresh wrapped domain before merging a pending mutation', async () => {
      rawStorageValue = JSON.stringify({
        wrapped: {
          uuid: 'encrypted-storage-object',
          content_type: 'SN|EncryptedStorage',
          content: '004:ciphertext',
          enc_item_key: 'encrypted-item-key',
          items_key_id: undefined,
          errorDecrypting: false,
          waitingForKey: false,
          deleted: false,
        },
        unwrapped: {},
        nonwrapped: {},
      })
      const decryptSplitSingle = jest.fn().mockResolvedValue({
        content: { encryptedExisting: 'preserved' },
        errorDecrypting: false,
      })
      const service = await createService({
        hasRootKeyEncryptionSource: jest.fn().mockReturnValue(false),
        decryptSplitSingle,
      })

      await service.setValueAndAwaitPersist('new-key', 'new-value')

      expect(decryptSplitSingle).toHaveBeenCalledTimes(1)
      expect(persistedUnwrappedValues()).toEqual(
        expect.objectContaining({
          encryptedExisting: 'preserved',
          'new-key': 'new-value',
        }),
      )
    })

    it('does not resurrect a physically deleted key when a stale instance later writes another key', async () => {
      const seeder = await createService()
      await seeder.setValuesAtomicallyAndAwaitPersist({
        doomed: 'remove-me',
        retained: 'keep-me',
      })

      const deletingService = await createService()
      const staleWritingService = await createService()
      const deleteWriteGate = createDeferred()

      ;(sharedDevice.setRawStorageValue as jest.Mock).mockImplementationOnce(async (key: string, value: string) => {
        await deleteWriteGate.promise
        persistRawValue(key, value)
      })

      const deleteWrite = deletingService.removeValue('doomed')
      await flush()
      const staleWrite = staleWritingService.setValueAndAwaitPersist('independent', 'new-value')
      await flush()

      expect(sharedDevice.setRawStorageValue).toHaveBeenCalledTimes(2)
      deleteWriteGate.resolve()
      await Promise.all([deleteWrite, staleWrite])

      const persisted = persistedUnwrappedValues()
      expect(Object.prototype.hasOwnProperty.call(persisted, 'doomed')).toBe(false)
      expect(persisted).toEqual(
        expect.objectContaining({
          retained: 'keep-me',
          independent: 'new-value',
        }),
      )
    })

    it('keeps mutations made as part of the same clear and ordinary post-clear mutations', async () => {
      const seeder = await createService()
      await seeder.setValuesAtomicallyAndAwaitPersist({
        obsoleteA: 'old-a',
        obsoleteB: 'old-b',
      })

      const clearingService = await createService()
      const clearWriteGate = createDeferred()

      ;(sharedDevice.setRawStorageValue as jest.Mock).mockImplementationOnce(async (key: string, value: string) => {
        await clearWriteGate.promise
        persistRawValue(key, value)
      })

      const clearWrite = clearingService.clearValues()
      await flush()
      clearingService.setValue('same-clear', 'survives')
      await flush()

      clearWriteGate.resolve()
      await clearWrite
      await clearingService.awaitPersist()
      await clearingService.setValueAndAwaitPersist('post-clear', 'also-survives')

      const persisted = persistedUnwrappedValues()
      expect(Object.prototype.hasOwnProperty.call(persisted, 'obsoleteA')).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(persisted, 'obsoleteB')).toBe(false)
      expect(persisted['same-clear']).toBe('survives')
      expect(persisted['post-clear']).toBe('also-survives')
    })

    it('does not resurrect a pending pre-clear mutation after another instance clears all data', async () => {
      const suspendedService = await createService()
      const clearingService = await createService()

      suspendedService['storagePersistable'] = false
      suspendedService.setValue('pre-clear-private-value', 'must-not-return')
      await suspendedService.awaitPersist()

      await clearingService.clearAllData()

      const clearedObject = JSON.parse(rawStorageValue as string) as Record<string, unknown>
      expect(rawGenerationValue).toBe('2')
      expect(clearedObject.storage_object_generation).toBe(2)
      expect(clearedObject.wrapped).toEqual({})
      expect(sharedDevice.removeRawStorageValue).not.toHaveBeenCalledWith(clearingService['getPersistenceKey']())

      suspendedService['storagePersistable'] = true
      await expect(suspendedService['persistValuesToDisk']()).rejects.toThrow('Storage context was cleared')

      expect(persistedUnwrappedValues()['pre-clear-private-value']).toBeUndefined()

      await suspendedService.setValueAndAwaitPersist('ordinary-post-clear-value', 'survives')
      expect(persistedUnwrappedValues()['ordinary-post-clear-value']).toBe('survives')
    })

    it('rejects an atomic KV mutation invoked before clear even when its local queue runs afterward', async () => {
      const suspendedService = await createService()
      const clearingService = await createService()
      const keyValueQueueGate = createDeferred()

      suspendedService['keyValueWriteQueue'] = keyValueQueueGate.promise
      const staleAtomicWrite = suspendedService.setValueAndAwaitPersist('queued-pre-clear-value', 'must-not-return')
      await flush()

      await clearingService.clearAllData()
      keyValueQueueGate.resolve()

      await expect(staleAtomicWrite).rejects.toThrow('Storage context was cleared')
      expect(persistedUnwrappedValues()['queued-pre-clear-value']).toBeUndefined()
    })

    it('ignores a legacy full-object overwrite that cannot carry the durable clear generation', async () => {
      const clearingService = await createService()
      await clearingService.clearAllData()

      rawStorageValue = JSON.stringify({
        wrapped: { content: { legacyPrivateValue: 'must-not-return' } },
        unwrapped: {},
        nonwrapped: {},
      })

      const restartedService = await createService()
      expect(restartedService.getValue('legacyPrivateValue')).toBeUndefined()

      await expect(restartedService.setValueAndAwaitPersist('new-generation-value', 'safe')).rejects.toThrow(
        'Storage context was cleared',
      )
      await restartedService.setValueAndAwaitPersist('new-generation-value', 'safe')
      expect(persistedUnwrappedValues()['legacyPrivateValue']).toBeUndefined()
      expect(persistedUnwrappedValues()['new-generation-value']).toBe('safe')
    })

    it('rejects rather than silently acknowledging a stale payload save after clearAllData', async () => {
      const suspendedService = await createService()
      const clearingService = await createService()
      const payloadQueueGate = createDeferred()

      suspendedService['storageWriteQueue'] = payloadQueueGate.promise
      const stalePayloadSave = suspendedService.savePayloads([])
      await flush()

      await clearingService.clearAllData()
      payloadQueueGate.resolve()

      await expect(stalePayloadSave).rejects.toThrow('Storage context was cleared')
      expect(sharedDevice.saveDatabaseEntries).not.toHaveBeenCalled()
    })

    it('rejects a current-looking payload save that starts while clearAllData is deleting payloads', async () => {
      const clearingService = await createService()
      const payloadClearStarted = createDeferred()
      const payloadClearGate = createDeferred()

      ;(sharedDevice.removeAllDatabaseEntries as jest.Mock).mockImplementationOnce(async () => {
        payloadClearStarted.resolve()
        await payloadClearGate.promise
      })

      const clearPromise = clearingService.clearAllData()
      await payloadClearStarted.promise

      expect(rawGenerationValue).toBe('1')
      const duringClearService = await createService()
      const payloadSave = duringClearService.savePayloads([])
      const rejectedSave = expect(payloadSave).rejects.toThrow('Storage context was cleared')
      const keyValueSave = clearingService.setValueAndAwaitPersist('during-clear-kv', 'must-not-survive')
      const rejectedKeyValueSave = expect(keyValueSave).rejects.toThrow('Storage context was cleared')
      await flush()
      expect(sharedDevice.saveDatabaseEntries).not.toHaveBeenCalled()

      payloadClearGate.resolve()
      await clearPromise
      await rejectedSave
      await rejectedKeyValueSave

      expect(rawGenerationValue).toBe('2')
      expect(sharedDevice.saveDatabaseEntries).not.toHaveBeenCalled()
      expect(persistedUnwrappedValues()['during-clear-kv']).toBeUndefined()
    })

    it('leaves an interrupted clear odd and rejects KV recovery shortcuts and payload reads', async () => {
      const clearingService = await createService()
      ;(sharedDevice.removeAllDatabaseEntries as jest.Mock).mockRejectedValueOnce(new Error('payload clear failed'))

      await expect(clearingService.clearAllData()).rejects.toThrow('payload clear failed')
      expect(rawGenerationValue).toBe('1')

      const restartedService = await createService()
      expect(restartedService['observedStorageObjectGeneration']).toBe(-1)

      await expect(restartedService.clearValues()).rejects.toThrow('Storage context was cleared')
      await expect(restartedService.clearValues()).rejects.toThrow('Storage context was cleared')
      await expect(restartedService.setValueAndAwaitPersist('unsafe-recovery', true)).rejects.toThrow(
        'Storage context was cleared',
      )
      await expect(restartedService.setValueAndAwaitPersist('unsafe-recovery', true)).rejects.toThrow(
        'Storage context was cleared',
      )
      await expect(restartedService.getAllRawPayloads()).rejects.toThrow('Storage context was cleared')
      await expect(restartedService.getRawPayloads(['payload-id'])).rejects.toThrow('Storage context was cleared')

      expect(rawGenerationValue).toBe('1')
      expect((JSON.parse(rawStorageValue as string) as Record<string, unknown>).storage_object_generation).toBe(1)
      expect(sharedDevice.getAllDatabaseEntries).not.toHaveBeenCalled()
      expect(sharedDevice.getDatabaseEntries).not.toHaveBeenCalled()
    })

    it('initializes fail-closed while ephemeral cleanup is in progress', async () => {
      const ephemeralService = await createService()
      await ephemeralService.setValueAndAwaitPersist('private-before-ephemeral', 'must-not-load')
      const cleanupStarted = createDeferred()
      const cleanupGate = createDeferred()

      ;(sharedDevice.clearNamespacedKeychainValue as jest.Mock).mockImplementationOnce(async () => {
        cleanupStarted.resolve()
        await cleanupGate.promise
      })

      const ephemeralPromise = ephemeralService.setPersistencePolicy(StoragePersistencePolicies.Ephemeral)
      await cleanupStarted.promise
      expect(rawGenerationValue).toBe('1')

      const midCleanupService = await createService()
      expect(midCleanupService.getValue('private-before-ephemeral')).toBeUndefined()
      expect(midCleanupService['observedStorageObjectGeneration']).toBe(-1)
      const payloadRead = expect(midCleanupService.getAllRawPayloads()).rejects.toThrow('Storage context was cleared')

      cleanupGate.resolve()
      await ephemeralPromise
      await payloadRead
      expect(rawGenerationValue).toBe('2')
      expect(sharedDevice.getAllDatabaseEntries).not.toHaveBeenCalled()
    })

    it.each([
      ['keychain deletion', 'clearNamespacedKeychainValue'],
      ['payload database deletion', 'removeAllDatabaseEntries'],
      ['raw storage deletion', 'removeRawStorageValuesForIdentifier'],
    ])('retains an odd ephemeral fence when %s fails', async (_label, method) => {
      const ephemeralService = await createService()
      const destructiveMethod = (sharedDevice as unknown as Record<string, jest.Mock>)[method]
      destructiveMethod.mockRejectedValueOnce(new Error(`${method} failed`))

      await expect(ephemeralService.setPersistencePolicy(StoragePersistencePolicies.Ephemeral)).rejects.toThrow(
        `${method} failed`,
      )

      expect(rawGenerationValue).toBe('1')
      expect((JSON.parse(rawStorageValue as string) as Record<string, unknown>).storage_object_generation).toBe(1)
      const restartedService = await createService()
      expect(restartedService['observedStorageObjectGeneration']).toBe(-1)
      await expect(restartedService.getAllRawPayloads()).rejects.toThrow('Storage context was cleared')
    })

    it('validates the payload generation again after a database read', async () => {
      const service = await createService()
      ;(sharedDevice.getAllDatabaseEntries as jest.Mock).mockImplementationOnce(async () => {
        rawGenerationValue = '2'
        rawStorageValue = JSON.stringify({
          wrapped: {},
          unwrapped: {},
          nonwrapped: {},
          storage_object_generation: 2,
        })
        return []
      })

      await expect(service.getAllRawPayloads()).rejects.toThrow('Storage context was cleared')
      expect(sharedDevice.getAllDatabaseEntries).toHaveBeenCalledTimes(1)
    })

    it('allows payload reads when the generation is stable and current', async () => {
      const service = await createService()

      await expect(service.isStorageContextCurrent()).resolves.toBe(true)
      await expect(service.getAllRawPayloads()).resolves.toEqual([])
      await expect(service.getRawPayloads(['payload-id'])).resolves.toEqual([])

      expect(sharedDevice.getAllDatabaseEntries).toHaveBeenCalledTimes(1)
      expect(sharedDevice.getDatabaseEntries).toHaveBeenCalledWith('shared-test', ['payload-id'])
    })

    it('reports an odd, stale, or incomplete storage generation as non-current', async () => {
      const service = await createService()

      rawGenerationValue = '1'
      await expect(service.isStorageContextCurrent()).resolves.toBe(false)

      rawGenerationValue = '2'
      rawStorageValue = JSON.stringify({
        wrapped: {},
        unwrapped: {},
        nonwrapped: {},
        storage_object_generation: 0,
      })
      await expect(service.isStorageContextCurrent()).resolves.toBe(false)

      rawStorageValue = JSON.stringify({
        wrapped: {},
        unwrapped: {},
        nonwrapped: {},
        storage_object_generation: 2,
      })
      await expect(service.isStorageContextCurrent()).resolves.toBe(false)
    })

    it('retains an empty generation fence when switching to ephemeral persistence', async () => {
      const suspendedService = await createService()
      const ephemeralService = await createService()

      suspendedService['storagePersistable'] = false
      suspendedService.setValue('pre-ephemeral-private-value', 'must-not-return')
      await suspendedService.awaitPersist()

      await ephemeralService.setPersistencePolicy(StoragePersistencePolicies.Ephemeral)

      expect(rawGenerationValue).toBe('2')
      expect(JSON.parse(rawStorageValue as string)).toEqual(expect.objectContaining({ storage_object_generation: 2 }))

      suspendedService['storagePersistable'] = true
      await expect(suspendedService['persistValuesToDisk']()).rejects.toThrow('Storage context was cleared')
      expect(persistedUnwrappedValues()['pre-ephemeral-private-value']).toBeUndefined()
    })

    it('keeps a newer local mutation in memory when it arrives during an older physical write', async () => {
      const service = await createService()
      const firstWriteGate = createDeferred()
      const secondWriteGate = createDeferred()

      ;(sharedDevice.setRawStorageValue as jest.Mock)
        .mockImplementationOnce(async (key: string, value: string) => {
          await firstWriteGate.promise
          persistRawValue(key, value)
        })
        .mockImplementationOnce(async (key: string, value: string) => {
          await secondWriteGate.promise
          persistRawValue(key, value)
        })

      const firstWrite = service.setValueAndAwaitPersist('checkpoint', 'first')
      await flush()
      service.setValue('checkpoint', 'newer')

      firstWriteGate.resolve()
      await firstWrite
      await flush()

      expect(service.getValue('checkpoint')).toBe('newer')
      expect(sharedDevice.setRawStorageValue).toHaveBeenCalledTimes(2)

      secondWriteGate.resolve()
      await service.awaitPersist()
      expect(persistedUnwrappedValues().checkpoint).toBe('newer')
    })
  })
})

import { DiskStorageService } from './DiskStorageService'
import { InternalEventBus, DeviceInterface, InternalEventBusInterface } from '@standardnotes/services'
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
      device.getRawStorageValue = jest.fn().mockImplementation(async () => rawStorageValue)
      device.setRawStorageValue = jest.fn().mockImplementation(async (_key: string, value: string) => {
        rawStorageValue = value
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
})

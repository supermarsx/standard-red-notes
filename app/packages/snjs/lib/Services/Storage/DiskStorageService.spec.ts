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
})

/* eslint-disable @typescript-eslint/no-explicit-any */
import { Database } from './Database'

/**
 * jsdom provides no IndexedDB implementation and `fake-indexeddb` is not a
 * dependency of this package, so these tests drive the Database class against a
 * tiny hand-rolled IDB mock. The mock is just enough to exercise the
 * silent-data-loss fixes:
 *   - FIX 1: a put() that fires onerror must reject savePayloads (not resolve).
 *   - FIX 2: getPayloadsForKeys must skip unreadable rows AND report them.
 *
 * Each "request" is an object whose onsuccess/onerror handlers Database assigns;
 * the mock invokes the chosen handler asynchronously (microtask) to mimic the
 * event-loop behavior of real IDB requests.
 */

type RequestBehavior = 'success' | 'error'

const fireAsync = (fn: () => void) => {
  Promise.resolve().then(fn)
}

class MockRequest {
  public onsuccess: ((event: any) => void) | null = null
  public onerror: ((event: any) => void) | null = null
  public result: any = undefined
  public error: any = undefined
}

class MockObjectStore {
  constructor(
    private putBehaviors: RequestBehavior[],
    private getResults: Array<{ behavior: RequestBehavior; result?: any }>,
    private transaction: MockTransaction,
  ) {}

  private putIndex = 0
  private getIndex = 0

  put(_item: any): MockRequest {
    const request = new MockRequest()
    const behavior = this.putBehaviors[this.putIndex++] ?? 'success'
    fireAsync(() => {
      if (behavior === 'error') {
        request.error = new DOMException('put failed', 'DataError')
        request.onerror && request.onerror({ target: request })
        // Real IDB: an unhandled request error aborts the transaction.
        this.transaction.abort(request.error)
      } else {
        request.onsuccess && request.onsuccess({ target: request })
      }
    })
    return request
  }

  get(_key: string): MockRequest {
    const request = new MockRequest()
    const spec = this.getResults[this.getIndex++] ?? { behavior: 'success' as const }
    fireAsync(() => {
      if (spec.behavior === 'error') {
        request.error = new DOMException('get failed', 'DataError')
        request.onerror && request.onerror({ target: request })
      } else {
        request.result = spec.result
        request.onsuccess && request.onsuccess({ target: request })
      }
    })
    return request
  }
}

class MockTransaction {
  public oncomplete: (() => void) | null = null
  public onerror: ((event: any) => void) | null = null
  public onabort: ((event: any) => void) | null = null
  private aborted = false

  constructor(private store: MockObjectStore | null) {}

  objectStore(): MockObjectStore {
    return this.store as MockObjectStore
  }

  setStore(store: MockObjectStore) {
    this.store = store
  }

  abort(error: any) {
    if (this.aborted) {
      return
    }
    this.aborted = true
    fireAsync(() => {
      this.onerror && this.onerror({ target: { error } })
      this.onabort && this.onabort({ target: { error } })
    })
  }

  complete() {
    fireAsync(() => {
      this.oncomplete && this.oncomplete()
    })
  }
}

const buildDatabaseWithMock = (mockDb: any): Database => {
  const database = new Database('test-db')
  database.unlock()
  // Bypass real openDatabase by injecting our mock IDBDatabase.
  ;(database as any).openDatabase = async () => mockDb
  return database
}

describe('Database silent-data-loss fixes', () => {
  describe('FIX 1: savePayloads rejects when a put fails', () => {
    it('rejects when an individual put fires onerror', async () => {
      const transaction = new MockTransaction(null)
      const store = new MockObjectStore(['success', 'error'], [], transaction)
      transaction.setStore(store)

      const mockDb = {
        transaction: () => transaction,
      }

      const database = buildDatabaseWithMock(mockDb)
      // Silence the alert path.
      ;(database as any).showGenericError = () => {}
      ;(database as any).showAlert = () => {}

      await expect(database.savePayloads([{ uuid: 'a' }, { uuid: 'b' }])).rejects.toBeDefined()
    })

    it('resolves when all puts succeed', async () => {
      const transaction = new MockTransaction(null)
      const store = new MockObjectStore(['success', 'success'], [], transaction)
      transaction.setStore(store)

      const mockDb = {
        transaction: () => transaction,
      }

      const database = buildDatabaseWithMock(mockDb)
      await expect(database.savePayloads([{ uuid: 'a' }, { uuid: 'b' }])).resolves.toBeUndefined()
    })
  })

  describe('FIX 2: getPayloadsForKeys reports skipped rows', () => {
    it('skips unreadable rows but warns with their uuids', async () => {
      const transaction = new MockTransaction(null)
      const store = new MockObjectStore(
        [],
        [
          { behavior: 'success', result: { uuid: 'a' } },
          { behavior: 'error' },
          { behavior: 'success', result: undefined }, // absent row
        ],
        transaction,
      )
      transaction.setStore(store)

      const mockDb = {
        transaction: () => transaction,
      }

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

      const database = buildDatabaseWithMock(mockDb)
      const payloads = await database.getPayloadsForKeys(['a', 'b', 'c'])

      expect(payloads).toEqual([{ uuid: 'a' }])
      expect(warnSpy).toHaveBeenCalledTimes(1)
      const message = warnSpy.mock.calls[0][0] as string
      expect(message).toContain('2 item(s) could not be read')
      expect(message).toContain('b')
      expect(message).toContain('c')

      warnSpy.mockRestore()
    })

    it('does not warn when every requested row is readable', async () => {
      const transaction = new MockTransaction(null)
      const store = new MockObjectStore(
        [],
        [
          { behavior: 'success', result: { uuid: 'a' } },
          { behavior: 'success', result: { uuid: 'b' } },
        ],
        transaction,
      )
      transaction.setStore(store)

      const mockDb = {
        transaction: () => transaction,
      }

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

      const database = buildDatabaseWithMock(mockDb)
      const payloads = await database.getPayloadsForKeys(['a', 'b'])

      expect(payloads).toEqual([{ uuid: 'a' }, { uuid: 'b' }])
      expect(warnSpy).not.toHaveBeenCalled()

      warnSpy.mockRestore()
    })
  })

  describe('cross-tab coordination hooks', () => {
    it('refuses to save (throws) when the keychain is locked by another tab', async () => {
      const transaction = new MockTransaction(null)
      const store = new MockObjectStore(['success'], [], transaction)
      transaction.setStore(store)
      const mockDb = { transaction: () => transaction }

      const database = buildDatabaseWithMock(mockDb)
      const emitSaved = jest.fn()
      database.setCrossTabHooks({ emitSaved, isWriteBlocked: () => true })

      await expect(database.savePayloads([{ uuid: 'a' }])).rejects.toThrow(/keychain changed in another tab/i)
      // Nothing was written, so nothing must have been broadcast.
      expect(emitSaved).not.toHaveBeenCalled()
    })

    it('emits the saved uuids after a successful save', async () => {
      const transaction = new MockTransaction(null)
      const store = new MockObjectStore(['success', 'success'], [], transaction)
      transaction.setStore(store)
      const mockDb = { transaction: () => transaction }

      const database = buildDatabaseWithMock(mockDb)
      const emitSaved = jest.fn()
      database.setCrossTabHooks({ emitSaved, isWriteBlocked: () => false })

      await database.savePayloads([{ uuid: 'a' }, { uuid: 'b' }])

      expect(emitSaved).toHaveBeenCalledTimes(1)
      expect(emitSaved).toHaveBeenCalledWith(['a', 'b'])
    })
  })
})

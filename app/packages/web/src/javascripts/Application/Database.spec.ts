/* eslint-disable @typescript-eslint/no-explicit-any */
import { Database } from './Database'
import { WebDevice } from './Device/WebDevice'

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

const flushMicrotasks = async () => {
  for (let index = 0; index < 6; index++) {
    await Promise.resolve()
  }
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

  private writeRequest(): MockRequest {
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

  put(_item: any): MockRequest {
    return this.writeRequest()
  }

  delete(_key: string): MockRequest {
    return this.writeRequest()
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
    if (this.aborted) {
      return
    }
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
      const savePromise = database.savePayloads([{ uuid: 'a' }, { uuid: 'b' }])
      let resolved = false
      void savePromise.then(() => {
        resolved = true
      })

      await flushMicrotasks()
      expect(resolved).toBe(false)

      transaction.complete()
      await expect(savePromise).resolves.toBeUndefined()
    })

    it('rejects when every put succeeds but the transaction aborts before commit', async () => {
      const transaction = new MockTransaction(null)
      const store = new MockObjectStore(['success', 'success'], [], transaction)
      transaction.setStore(store)
      const mockDb = { transaction: () => transaction }

      const database = buildDatabaseWithMock(mockDb)
      ;(database as any).showGenericError = () => {}
      ;(database as any).showAlert = () => {}
      const savePromise = database.savePayloads([{ uuid: 'a' }, { uuid: 'b' }])
      const assertion = expect(savePromise).rejects.toThrow('commit failed')

      await flushMicrotasks()
      transaction.abort(new DOMException('commit failed', 'QuotaExceededError'))

      await assertion
    })
  })

  describe('deletePayload waits for transaction durability', () => {
    it('does not resolve on request success before the transaction commits', async () => {
      const transaction = new MockTransaction(null)
      const store = new MockObjectStore(['success'], [], transaction)
      transaction.setStore(store)
      const database = buildDatabaseWithMock({ transaction: () => transaction })

      const deletePromise = database.deletePayload('a')
      let resolved = false
      void deletePromise.then(() => {
        resolved = true
      })

      await flushMicrotasks()
      expect(resolved).toBe(false)

      transaction.complete()
      await expect(deletePromise).resolves.toBeUndefined()
    })

    it('rejects when the delete request succeeds but the transaction aborts', async () => {
      const transaction = new MockTransaction(null)
      const store = new MockObjectStore(['success'], [], transaction)
      transaction.setStore(store)
      const database = buildDatabaseWithMock({ transaction: () => transaction })
      const deletePromise = database.deletePayload('a')
      const assertion = expect(deletePromise).rejects.toThrow('delete commit failed')

      await flushMicrotasks()
      transaction.abort(new DOMException('delete commit failed', 'UnknownError'))

      await assertion
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

      const savePromise = database.savePayloads([{ uuid: 'a' }, { uuid: 'b' }])
      await flushMicrotasks()
      expect(emitSaved).not.toHaveBeenCalled()
      transaction.complete()
      await savePromise

      expect(emitSaved).toHaveBeenCalledTimes(1)
      expect(emitSaved).toHaveBeenCalledWith(['a', 'b'])
    })

    it('does not emit saved uuids when the transaction aborts after request success', async () => {
      const transaction = new MockTransaction(null)
      const store = new MockObjectStore(['success'], [], transaction)
      transaction.setStore(store)
      const database = buildDatabaseWithMock({ transaction: () => transaction })
      ;(database as any).showGenericError = () => {}
      ;(database as any).showAlert = () => {}
      const emitSaved = jest.fn()
      database.setCrossTabHooks({ emitSaved, isWriteBlocked: () => false })

      const savePromise = database.savePayloads([{ uuid: 'a' }])
      const assertion = expect(savePromise).rejects.toThrow('commit failed')
      await flushMicrotasks()
      transaction.abort(new DOMException('commit failed', 'UnknownError'))
      await assertion

      expect(emitSaved).not.toHaveBeenCalled()
    })
  })

  /**
   * MULTI-TAB READS. A read whose transaction dies mid-cursor used to leave its promise
   * unsettled forever, so SyncService.loadDatabasePayloads awaited a value that never came
   * and the app sat with an empty, still-loading item list. These prove the read now
   * REJECTS, which the loader already isolates and reports.
   */
  describe('a read whose transaction dies settles instead of hanging', () => {
    const neverSettles = async (promise: Promise<unknown>) => {
      const sentinel = Symbol('pending')
      const result = await Promise.race([
        promise.then(
          () => 'resolved',
          () => 'rejected',
        ),
        flushMicrotasks().then(() => sentinel),
      ])
      return result === sentinel
    }

    it('rejects getPayloadsForKeys when the transaction aborts before every row answers', async () => {
      const transaction = new MockTransaction(null)
      /**
       * Only the first of three keys answers; the other two requests never fire, which is
       * what a transaction dying mid-read looks like. Before the fix this promise never
       * settled at all.
       */
      let answered = 0
      const store = {
        get: (key: string) => {
          const request = new MockRequest()
          if (answered++ === 0) {
            fireAsync(() => {
              request.result = { uuid: key }
              request.onsuccess && request.onsuccess({ target: request })
            })
          }
          return request
        },
      } as unknown as MockObjectStore
      transaction.setStore(store)
      const database = buildDatabaseWithMock({ transaction: () => transaction })

      const readPromise = database.getPayloadsForKeys(['a', 'b', 'c'])
      const assertion = expect(readPromise).rejects.toThrow('store went away')

      await flushMicrotasks()
      transaction.abort(new DOMException('store went away', 'InvalidStateError'))

      await assertion
    })

    it('rejects getAllMetadata when the cursor transaction aborts', async () => {
      const transaction = new MockTransaction(null)
      const cursorRequest = new MockRequest()
      const store = {
        openCursor: () => cursorRequest,
      } as unknown as MockObjectStore
      transaction.setStore(store)
      const database = buildDatabaseWithMock({ transaction: () => transaction })

      const readPromise = database.getAllMetadata()
      const assertion = expect(readPromise).rejects.toThrow('cursor died')

      await flushMicrotasks()
      transaction.abort(new DOMException('cursor died', 'InvalidStateError'))

      await assertion
    })

    it('a cursor read that is still streaming is not settled early', async () => {
      const transaction = new MockTransaction(null)
      const cursorRequest = new MockRequest()
      const store = {
        openCursor: () => cursorRequest,
      } as unknown as MockObjectStore
      transaction.setStore(store)
      const database = buildDatabaseWithMock({ transaction: () => transaction })

      expect(await neverSettles(database.getAllMetadata())).toBe(true)
    })
  })

  /**
   * MULTI-TAB HANDLES. Another tab deleting the database closes this tab's handle. The
   * cached reference must be dropped, or openDatabase() keeps handing out a CLOSED handle
   * and every later read and write throws for the rest of the page's life.
   */
  describe('a handle closed by another tab is not reused', () => {
    const installOpenMock = () => {
      const opened: FakeIDBDatabase[] = []
      const open = jest.fn(() => {
        const request: any = { onerror: null, onblocked: null, onsuccess: null, onupgradeneeded: null }
        const db = new FakeIDBDatabase()
        opened.push(db)
        request.result = db
        fireAsync(() => {
          request.onsuccess && request.onsuccess({ target: request })
        })
        return request
      })
      ;(window as any).indexedDB = { open }
      return { opened, open }
    }

    it('re-opens after a versionchange closed the previous handle', async () => {
      const { opened, open } = installOpenMock()
      const database = new Database('handle-db')
      database.unlock()

      const first = await database.openDatabase()
      expect(open).toHaveBeenCalledTimes(1)
      expect(await database.openDatabase()).toBe(first)
      expect(open).toHaveBeenCalledTimes(1)

      /** Another tab called deleteDatabase: the browser fires versionchange on ours. */
      opened[0].onversionchange?.()
      expect(opened[0].closed).toBe(true)

      const second = await database.openDatabase()
      expect(open).toHaveBeenCalledTimes(2)
      expect(second).not.toBe(first)
    })

    it('re-opens after the browser force-closed the handle', async () => {
      const { opened, open } = installOpenMock()
      const database = new Database('handle-db')
      database.unlock()

      await database.openDatabase()
      opened[0].onclose?.()

      await database.openDatabase()
      expect(open).toHaveBeenCalledTimes(2)
    })
  })
})

/**
 * `Database.deleteAll` unioned the caller's workspace identifiers with EVERY name
 * `indexedDB.databases()` returned. That listing is per-ORIGIN, not per-application, so on a
 * shared origin — this app served under a path alongside anything else on the same host —
 * "remove all local data" deleted databases belonging to other applications entirely.
 *
 * The listing union is only an orphan sweep for workspace databases whose descriptor was
 * already lost, so it is scoped to this app's own naming scheme: the legacy 'standardnotes'
 * name and the uuid ApplicationGroup.createNewApplicationDescriptor generates.
 */
describe('Database.deleteAll is scoped to this application', () => {
  const originalIndexedDB = (window as any).indexedDB
  const originalLockManager = navigator.locks

  /** Names a real shared origin could be hosting next to this app. */
  const FOREIGN_NAMES = [
    'vogue-homes-crm',
    'firebaseLocalStorageDb',
    'keyval-store',
    'srn-device-keychain-key',
    'standardnotes-analytics',
    'workbox-expiration',
  ]

  /** This app's own: the legacy first workspace plus two generated workspace identifiers. */
  const OWN_NAMES = ['standardnotes', '018f3d2c-9a41-7b55-8e0d-6f2a1b3c4d5e', 'A1B2C3D4-1234-4321-ABCD-0123456789AB']

  const installDatabaseListing = (names: string[]) => {
    const deleted: string[] = []
    const databases = jest.fn(async () => names.map((name) => ({ name, version: 1 })))
    const deleteDatabase = jest.fn((name: string) => {
      const request: any = { onerror: null, onsuccess: null, onblocked: null }
      fireAsync(() => {
        deleted.push(name)
        request.onsuccess && request.onsuccess({ target: request })
      })
      return request
    })
    ;(window as any).indexedDB = {
      databases,
      deleteDatabase,
      open: jest.fn(() => {
        throw new Error('no device-key database in this test')
      }),
    }
    return { deleted, databases, deleteDatabase }
  }

  afterEach(() => {
    ;(window as any).indexedDB = originalIndexedDB
    Object.defineProperty(navigator, 'locks', { configurable: true, value: originalLockManager })
  })

  it('leaves every foreign database on the origin alone', async () => {
    const { deleted } = installDatabaseListing([...FOREIGN_NAMES, ...OWN_NAMES])

    await Database.deleteAll(['standardnotes'])

    expect(deleted.sort()).toEqual([...OWN_NAMES].sort())
    for (const foreign of FOREIGN_NAMES) {
      expect(deleted).not.toContain(foreign)
    }
  })

  it('still sweeps an orphaned workspace database the caller did not know about', async () => {
    const orphan = '018f3d2c-9a41-7b55-8e0d-aaaaaaaaaaaa'
    const { deleted } = installDatabaseListing(['standardnotes', orphan, 'vogue-homes-crm'])

    await Database.deleteAll(['standardnotes'])

    expect(deleted).toContain(orphan)
    expect(deleted).not.toContain('vogue-homes-crm')
  })

  it('deletes every name the caller passed, whatever its shape', async () => {
    // The caller's list is authoritative: it comes from the descriptor record, so an
    // identifier that does not look like a uuid is still this app's own database.
    const { deleted } = installDatabaseListing(['vogue-homes-crm'])

    await Database.deleteAll(['a-legacy-custom-identifier'])

    expect(deleted).toEqual(['a-legacy-custom-identifier'])
  })

  it('classifies names by the naming scheme this app uses', () => {
    expect(Database.isOwnDatabaseName('standardnotes')).toBe(true)
    expect(Database.isOwnDatabaseName('018f3d2c-9a41-7b55-8e0d-6f2a1b3c4d5e')).toBe(true)
    // Not a bare prefix match, not a substring match, not a near-miss uuid.
    expect(Database.isOwnDatabaseName('standardnotes-analytics')).toBe(false)
    expect(Database.isOwnDatabaseName('my-standardnotes')).toBe(false)
    expect(Database.isOwnDatabaseName('018f3d2c-9a41-7b55-8e0d-6f2a1b3c4d5')).toBe(false)
    expect(Database.isOwnDatabaseName('018f3d2c9a417b558e0d6f2a1b3c4d5e')).toBe(false)
    expect(Database.isOwnDatabaseName('zzzzzzzz-9a41-7b55-8e0d-6f2a1b3c4d5e')).toBe(false)
    expect(Database.isOwnDatabaseName('')).toBe(false)
  })

  it('spares foreign databases on the real remove-all-data path through WebDevice', async () => {
    // The production caller: ApplicationGroup -> device.clearAllDataFromDevice(identifiers).
    const { deleted } = installDatabaseListing([...FOREIGN_NAMES, ...OWN_NAMES])
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: <T>(name: string, _options: LockOptions, callback: LockGrantedCallback<T>): Promise<T> =>
          Promise.resolve(callback({ name, mode: 'exclusive' } as Lock)),
      },
    })

    const device = new WebDevice('test-version')
    const result = await device.clearAllDataFromDevice(['standardnotes'] as any)

    expect(result).toEqual({ killsApplication: false })
    expect(deleted.sort()).toEqual([...OWN_NAMES].sort())
    expect(deleted).not.toContain('vogue-homes-crm')
    device.deinit()
  })
})

class FakeIDBDatabase {
  public closed = false
  public onversionchange: (() => void) | null = null
  public onclose: (() => void) | null = null
  public onerror: ((event: any) => void) | null = null

  close() {
    this.closed = true
  }
}

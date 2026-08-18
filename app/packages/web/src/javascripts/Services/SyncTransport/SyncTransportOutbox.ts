export type SyncOutboxRecord = {
  /** Opaque authenticated user + session epoch; never a raw credential. */
  sessionScope: string
  /** Session-scoped endpoint/device ownership key. */
  transportScope: string
  commandId: string
  digest: string
  sequence: number
  /** Stable originating user action; not secret and scoped by sessionScope. */
  operationId?: string
  /** Exact UTF-8 command frame sent to the gateway. */
  bytes: string
  createdAt: number
  /** Retained for audit/safety but never replayed after its session is revoked. */
  revoked?: boolean
}

export interface SyncOutboxStore {
  put(record: SyncOutboxRecord): Promise<void>
  oldest(sessionScope: string): Promise<SyncOutboxRecord | undefined>
  quarantineSessionScope(sessionScope: string): Promise<void>
  delete(sessionScope: string, commandId: string): Promise<void>
  acquireOwner(
    transportScope: string,
    sessionScope: string,
    ownerId: string,
    now: number,
    ttlMs: number,
  ): Promise<boolean>
  renewOwner(
    transportScope: string,
    sessionScope: string,
    ownerId: string,
    now: number,
    ttlMs: number,
  ): Promise<boolean>
  releaseOwner(transportScope: string, sessionScope: string, ownerId: string): Promise<void>
  close(): void
}

type OwnerLease = {
  transportScope: string
  sessionScope: string
  ownerId: string
  expiresAt: number
}

const DATABASE_NAME = 'standardnotes-sync-transport-v1'
const DATABASE_VERSION = 2
// Keep the v1 stores untouched. Records without an authenticated session scope
// are intentionally invisible to v2 and can therefore never cross accounts.
const COMMAND_STORE = 'commands-v2'
const LEASE_STORE = 'leases-v2'
const SESSION_SCOPE_INDEX = 'sessionScope'

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
  })
}

export class IndexedDbSyncOutbox implements SyncOutboxStore {
  private databasePromise?: Promise<IDBDatabase>

  constructor(private readonly factory: IDBFactory | undefined = globalThis.indexedDB) {}

  async put(record: SyncOutboxRecord): Promise<void> {
    const database = await this.database()
    const transaction = database.transaction(COMMAND_STORE, 'readwrite')
    transaction.objectStore(COMMAND_STORE).put(record)
    await transactionDone(transaction)
  }

  async oldest(sessionScope: string): Promise<SyncOutboxRecord | undefined> {
    const database = await this.database()
    const transaction = database.transaction(COMMAND_STORE, 'readonly')
    const records = (await requestResult(
      transaction.objectStore(COMMAND_STORE).index(SESSION_SCOPE_INDEX).getAll(sessionScope),
    )) as SyncOutboxRecord[]
    await transactionDone(transaction)
    return records
      .filter((record) => record.sessionScope === sessionScope && record.revoked !== true)
      .sort((left, right) => left.createdAt - right.createdAt || left.sequence - right.sequence)[0]
  }

  async quarantineSessionScope(sessionScope: string): Promise<void> {
    const database = await this.database()
    const transaction = database.transaction(COMMAND_STORE, 'readwrite')
    const store = transaction.objectStore(COMMAND_STORE)
    const records = (await requestResult(store.index(SESSION_SCOPE_INDEX).getAll(sessionScope))) as SyncOutboxRecord[]
    for (const record of records) {
      if (record.sessionScope === sessionScope && record.revoked !== true) {
        store.put({ ...record, revoked: true } satisfies SyncOutboxRecord)
      }
    }
    await transactionDone(transaction)
  }

  async delete(sessionScope: string, commandId: string): Promise<void> {
    const database = await this.database()
    const transaction = database.transaction(COMMAND_STORE, 'readwrite')
    transaction.objectStore(COMMAND_STORE).delete([sessionScope, commandId])
    await transactionDone(transaction)
  }

  async acquireOwner(
    transportScope: string,
    sessionScope: string,
    ownerId: string,
    now: number,
    ttlMs: number,
  ): Promise<boolean> {
    const database = await this.database()
    const transaction = database.transaction(LEASE_STORE, 'readwrite')
    const store = transaction.objectStore(LEASE_STORE)
    const current = (await requestResult(store.get(transportScope))) as OwnerLease | undefined
    const acquired =
      !current || current.sessionScope !== sessionScope || current.expiresAt <= now || current.ownerId === ownerId
    if (acquired) {
      store.put({ transportScope, sessionScope, ownerId, expiresAt: now + ttlMs } satisfies OwnerLease)
    }
    await transactionDone(transaction)
    return acquired
  }

  async renewOwner(
    transportScope: string,
    sessionScope: string,
    ownerId: string,
    now: number,
    ttlMs: number,
  ): Promise<boolean> {
    const database = await this.database()
    const transaction = database.transaction(LEASE_STORE, 'readwrite')
    const store = transaction.objectStore(LEASE_STORE)
    const current = (await requestResult(store.get(transportScope))) as OwnerLease | undefined
    const owned = current?.sessionScope === sessionScope && current.ownerId === ownerId && current.expiresAt > now
    if (owned) {
      store.put({ transportScope, sessionScope, ownerId, expiresAt: now + ttlMs } satisfies OwnerLease)
    }
    await transactionDone(transaction)
    return owned
  }

  async releaseOwner(transportScope: string, sessionScope: string, ownerId: string): Promise<void> {
    const database = await this.database()
    const transaction = database.transaction(LEASE_STORE, 'readwrite')
    const store = transaction.objectStore(LEASE_STORE)
    const current = (await requestResult(store.get(transportScope))) as OwnerLease | undefined
    if (current?.sessionScope === sessionScope && current.ownerId === ownerId) {
      store.delete(transportScope)
    }
    await transactionDone(transaction)
  }

  close(): void {
    void this.databasePromise?.then((database) => database.close()).catch(() => undefined)
    this.databasePromise = undefined
  }

  private database(): Promise<IDBDatabase> {
    if (!this.factory) {
      return Promise.reject(new Error('IndexedDB is unavailable'))
    }
    if (!this.databasePromise) {
      this.databasePromise = new Promise((resolve, reject) => {
        const request = this.factory?.open(DATABASE_NAME, DATABASE_VERSION)
        if (!request) {
          reject(new Error('IndexedDB is unavailable'))
          return
        }
        request.onupgradeneeded = () => {
          const database = request.result
          if (!database.objectStoreNames.contains(COMMAND_STORE)) {
            const commands = database.createObjectStore(COMMAND_STORE, {
              keyPath: ['sessionScope', 'commandId'],
            })
            commands.createIndex(SESSION_SCOPE_INDEX, SESSION_SCOPE_INDEX, { unique: false })
          }
          if (!database.objectStoreNames.contains(LEASE_STORE)) {
            database.createObjectStore(LEASE_STORE, { keyPath: 'transportScope' })
          }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('Could not open sync outbox'))
        request.onblocked = () => reject(new Error('Sync outbox upgrade was blocked'))
      })
    }
    return this.databasePromise
  }
}

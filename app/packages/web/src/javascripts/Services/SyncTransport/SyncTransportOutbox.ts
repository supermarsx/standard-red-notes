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
  /**
   * Set durably immediately before WebSocket.send. Once present, a process or
   * socket failure is ambiguous and HTTP replay is forbidden until STATUS
   * confirms UNKNOWN.
   */
  dispatchedAt?: number
  /** Retained for audit/safety but never replayed after its session is revoked. */
  revoked?: boolean
}

/**
 * The store itself could not be opened, so nothing can be read or written. Every
 * other failure describes one operation; this one describes the whole lane, and
 * the caller answers it by going to HTTP rather than by demanding a durable
 * recovery it can never perform.
 */
export class SyncOutboxUnavailableError extends Error {
  readonly outboxUnavailable = true

  constructor(message: string) {
    super(message)
    this.name = 'SyncOutboxUnavailableError'
  }
}

export function isSyncOutboxUnavailable(error: unknown): boolean {
  return (
    error instanceof SyncOutboxUnavailableError ||
    (error as { outboxUnavailable?: boolean })?.outboxUnavailable === true
  )
}

/** How long one tab's claim on a transport scope stands without renewal. */
export const OWNER_LEASE_TTL_MS = 15_000

export interface SyncOutboxStore {
  put(record: SyncOutboxRecord): Promise<void>
  oldest(sessionScope: string): Promise<SyncOutboxRecord | undefined>
  quarantineSessionScope(sessionScope: string): Promise<void>
  delete(sessionScope: string, commandId: string): Promise<void>
  /**
   * True only when a DIFFERENT owner holds an unexpired lease on this scope. A
   * cheap read that answers "is another tab already driving this socket?"
   * before a one-use ticket is minted to ask the same question.
   */
  heldByAnotherOwner(transportScope: string, sessionScope: string, ownerId: string, now: number): Promise<boolean>
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
  /** Identifies the open attempt that owns `databasePromise` right now. */
  private openAttempt = 0

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

  async heldByAnotherOwner(
    transportScope: string,
    sessionScope: string,
    ownerId: string,
    now: number,
  ): Promise<boolean> {
    const database = await this.database()
    const transaction = database.transaction(LEASE_STORE, 'readonly')
    const current = (await requestResult(transaction.objectStore(LEASE_STORE).get(transportScope))) as
      OwnerLease | undefined
    await transactionDone(transaction)
    return (
      current !== undefined &&
      current.sessionScope === sessionScope &&
      current.ownerId !== ownerId &&
      current.expiresAt > now
    )
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
      return Promise.reject(new SyncOutboxUnavailableError('IndexedDB is unavailable'))
    }
    if (this.databasePromise) {
      return this.databasePromise
    }
    // A rejected open must never be remembered. Caching it turned one blocked
    // version bump (an older tab still holding the previous version open) into a
    // permanently unusable store for the life of this worker, and every sync
    // after it asked for a durable recovery that could never run.
    //
    // Guarded by the attempt number rather than by promise identity so a late
    // handler from a superseded attempt (including one this `close()` dropped)
    // cannot discard the connection a later attempt opened.
    const attempt = ++this.openAttempt
    const forget = () => {
      if (this.openAttempt === attempt) {
        this.databasePromise = undefined
      }
    }
    const pending = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory?.open(DATABASE_NAME, DATABASE_VERSION)
      if (!request) {
        reject(new SyncOutboxUnavailableError('IndexedDB is unavailable'))
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
      request.onsuccess = () => {
        const database = request.result
        // Another tab is upgrading the schema. Holding this connection open
        // blocks its open (and therefore its whole sync lane) until this page
        // closes; step aside and re-open on the next operation instead.
        database.onversionchange = () => {
          database.close()
          forget()
        }
        resolve(database)
      }
      request.onerror = () =>
        reject(new SyncOutboxUnavailableError(request.error?.message ?? 'Could not open sync outbox'))
      request.onblocked = () => reject(new SyncOutboxUnavailableError('Sync outbox upgrade was blocked'))
    }).catch((error: unknown) => {
      forget()
      throw error
    })
    this.databasePromise = pending
    return pending
  }
}

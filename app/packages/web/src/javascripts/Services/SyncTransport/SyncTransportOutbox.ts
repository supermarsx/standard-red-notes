export type SyncOutboxRecord = {
  /** Durable transport constraint, retained across editor teardown and worker restarts. */
  socketOnly?: boolean
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

/**
 * What happened to a renewal attempt.
 *
 * *** THIS USED TO BE A BOOLEAN, AND THE BOOLEAN CONFLATED TWO DIFFERENT FACTS. ***
 *
 * `renewOwner` answered `false` both when another tab had taken the lane and when
 * the caller's OWN row had merely aged out — and a tab's own row ages out for the
 * most ordinary reason there is: the tab was frozen or backgrounded, so its 5 s
 * renewal interval did not run. The caller mapped every `false` onto
 * `multi-tab-not-owner`, a `deferred` disposition, which the main thread then
 * suppresses for a whole lease TTL. A single tab with no sibling anywhere therefore
 * reported a sibling tab that did not exist and parked itself behind it.
 *
 * - `renewed` — the lease is ours and now stands for another TTL.
 * - `lapsed` — NO live lease stands for this scope. Ours aged out, or it was
 *   released, and nothing has claimed it since. Nobody owns the lane: the caller
 *   may take it back, and the right answer is to dial again rather than to wait.
 * - `taken` — a DIFFERENT owner holds a live lease. The caller must stand down
 *   until that lease ends, which is the one condition `multi-tab-not-owner`
 *   describes.
 */
export type OwnerRenewalOutcome = 'renewed' | 'lapsed' | 'taken'

/**
 * The renewal verdict, as a pure function of the stored row.
 *
 * Exported and shared so a test double cannot drift from the store it stands in
 * for: a fake that answered `renewed` where the real store answers `lapsed` would
 * make the surrender path untestable while every spec passed.
 */
export function ownerRenewalOutcome(
  current: { sessionScope: string; ownerId: string; expiresAt: number } | undefined,
  sessionScope: string,
  ownerId: string,
  now: number,
): OwnerRenewalOutcome {
  if (current === undefined || current.sessionScope !== sessionScope || current.expiresAt <= now) {
    // No row, a row belonging to another session, or an expired row — including
    // our own. `acquireOwner` treats all three as claimable, so they are not a
    // sibling tab and must not be reported as one.
    return 'lapsed'
  }
  return current.ownerId === ownerId ? 'renewed' : 'taken'
}

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
  /**
   * The same question for a tab that does not yet know its own transport scope:
   * does ANY live lease for this session belong to another owner? A tab learns
   * its scope only from a ticket (the endpoint comes back with it), so a point
   * lookup cannot answer before the first dial — and paying a ticket to learn
   * what this store already knows is the cost this exists to remove.
   */
  sessionHeldByAnotherOwner(sessionScope: string, ownerId: string, now: number): Promise<boolean>
  acquireOwner(
    transportScope: string,
    sessionScope: string,
    ownerId: string,
    now: number,
    ttlMs: number,
  ): Promise<boolean>
  /**
   * Extends this owner's lease, and says WHY it could not when it could not. See
   * `OwnerRenewalOutcome`: a caller handed a bare `false` cannot tell a sibling tab
   * from its own clock.
   */
  renewOwner(
    transportScope: string,
    sessionScope: string,
    ownerId: string,
    now: number,
    ttlMs: number,
  ): Promise<OwnerRenewalOutcome>
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

  async sessionHeldByAnotherOwner(sessionScope: string, ownerId: string, now: number): Promise<boolean> {
    const database = await this.database()
    const transaction = database.transaction(LEASE_STORE, 'readonly')
    const leases = (await requestResult(transaction.objectStore(LEASE_STORE).getAll())) as OwnerLease[]
    await transactionDone(transaction)
    // One row per transport scope, and a scope is a session plus an endpoint
    // plus a device, so this store holds a handful of rows at most.
    return leases.some(
      (lease) => lease.sessionScope === sessionScope && lease.ownerId !== ownerId && lease.expiresAt > now,
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
  ): Promise<OwnerRenewalOutcome> {
    const database = await this.database()
    const transaction = database.transaction(LEASE_STORE, 'readwrite')
    const store = transaction.objectStore(LEASE_STORE)
    const current = (await requestResult(store.get(transportScope))) as OwnerLease | undefined
    const outcome = ownerRenewalOutcome(current, sessionScope, ownerId, now)
    if (outcome === 'renewed') {
      store.put({ transportScope, sessionScope, ownerId, expiresAt: now + ttlMs } satisfies OwnerLease)
    }
    await transactionDone(transaction)
    return outcome
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

  protected database(): Promise<IDBDatabase> {
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

/**
 * Independent workers may hold independent sockets. Only a pending command,
 * rather than the account's entire connection, needs an exclusive recovery owner.
 *
 * Keep the v2 schema: an upgrade would close an older worker's database. Namespace
 * new rows instead, so an older build cannot mistake our live command for its own.
 * Legacy rows stay in place and are recovered only after their owner releases or
 * expires. Device IDs and exact command bytes never change during recovery.
 */
export class ConcurrentIndexedDbSyncOutbox extends IndexedDbSyncOutbox {
  private readonly claims = new Map<string, string>()
  private readonly prefix = 'parallel-v1:'

  constructor(
    private readonly workerId: string,
    private readonly now: () => number = Date.now,
    factory: IDBFactory | undefined = globalThis.indexedDB,
  ) {
    super(factory)
  }

  private storageSession(sessionScope: string): string {
    return `${this.prefix}${sessionScope}`
  }

  private storageTransport(transportScope: string): string {
    return transportScope.startsWith(this.prefix) ? transportScope : `${this.prefix}${this.workerId}|${transportScope}`
  }

  override async oldest(sessionScope: string): Promise<SyncOutboxRecord | undefined> {
    const database = await this.database()
    const transaction = database.transaction([COMMAND_STORE, LEASE_STORE], 'readwrite')
    const commands = transaction.objectStore(COMMAND_STORE)
    const leases = transaction.objectStore(LEASE_STORE)
    const index = commands.index(SESSION_SCOPE_INDEX)
    const [current, legacy, owners] = await Promise.all([
      requestResult(index.getAll(this.storageSession(sessionScope))) as Promise<SyncOutboxRecord[]>,
      requestResult(index.getAll(sessionScope)) as Promise<SyncOutboxRecord[]>,
      requestResult(leases.getAll()) as Promise<OwnerLease[]>,
    ])
    const now = this.now()
    const record = [...current, ...legacy]
      .filter((candidate) => {
        const owner = owners.find((lease) => lease.transportScope === candidate.transportScope)
        return candidate.revoked !== true && (!owner || owner.expiresAt <= now || owner.ownerId === this.workerId)
      })
      .sort((a, b) => a.createdAt - b.createdAt || a.sequence - b.sequence)[0]
    if (record) {
      leases.put({
        transportScope: record.transportScope,
        sessionScope: record.sessionScope,
        ownerId: this.workerId,
        expiresAt: now + OWNER_LEASE_TTL_MS,
      } satisfies OwnerLease)
    }
    await transactionDone(transaction)
    if (record) {
      this.claims.set(record.transportScope, record.sessionScope)
      return { ...record, sessionScope }
    }
    return undefined
  }

  override async put(record: SyncOutboxRecord): Promise<void> {
    const database = await this.database()
    const transaction = database.transaction([COMMAND_STORE, LEASE_STORE], 'readwrite')
    const commands = transaction.objectStore(COMMAND_STORE)
    const leases = transaction.objectStore(LEASE_STORE)
    const storageSession = this.storageSession(record.sessionScope)
    const [current, legacy] = await Promise.all([
      requestResult(commands.get([storageSession, record.commandId])) as Promise<SyncOutboxRecord | undefined>,
      requestResult(commands.get([record.sessionScope, record.commandId])) as Promise<SyncOutboxRecord | undefined>,
    ])
    const existing = current ?? legacy
    if (existing && (existing.digest !== record.digest || existing.bytes !== record.bytes || existing.revoked)) {
      await transactionDone(transaction)
      throw new Error('Pending sync command identity cannot be replaced')
    }
    const physical = {
      ...record,
      sessionScope: existing?.sessionScope ?? storageSession,
      transportScope: existing?.transportScope ?? this.storageTransport(record.transportScope),
    }
    const owner = (await requestResult(leases.get(physical.transportScope))) as OwnerLease | undefined
    if (owner && owner.ownerId !== this.workerId && owner.expiresAt > this.now()) {
      await transactionDone(transaction)
      throw new Error('Pending sync command belongs to another recovery worker')
    }
    leases.put({
      transportScope: physical.transportScope,
      sessionScope: physical.sessionScope,
      ownerId: this.workerId,
      expiresAt: this.now() + OWNER_LEASE_TTL_MS,
    } satisfies OwnerLease)
    commands.put(physical)
    await transactionDone(transaction)
    this.claims.set(physical.transportScope, physical.sessionScope)
  }

  override async delete(sessionScope: string, commandId: string): Promise<void> {
    const database = await this.database()
    const transaction = database.transaction([COMMAND_STORE, LEASE_STORE], 'readwrite')
    const commands = transaction.objectStore(COMMAND_STORE)
    const leases = transaction.objectStore(LEASE_STORE)
    const records = await Promise.all([
      requestResult(commands.get([this.storageSession(sessionScope), commandId])) as Promise<
        SyncOutboxRecord | undefined
      >,
      requestResult(commands.get([sessionScope, commandId])) as Promise<SyncOutboxRecord | undefined>,
    ])
    for (const record of records) {
      if (!record) {
        continue
      }
      const owner = (await requestResult(leases.get(record.transportScope))) as OwnerLease | undefined
      if (owner && owner.ownerId !== this.workerId && owner.expiresAt > this.now()) {
        await transactionDone(transaction)
        throw new Error('Pending sync command belongs to another recovery worker')
      }
    }
    for (const record of records) {
      if (record) {
        commands.delete([record.sessionScope, commandId])
      }
    }
    const released: string[] = []
    for (const record of records) {
      if (!record || record.transportScope.startsWith(`${this.prefix}${this.workerId}|`)) {
        continue
      }
      const remaining = (await requestResult(
        commands.index(SESSION_SCOPE_INDEX).getAll(record.sessionScope),
      )) as SyncOutboxRecord[]
      if (!remaining.some((candidate) => candidate.transportScope === record.transportScope && !candidate.revoked)) {
        leases.delete(record.transportScope)
        released.push(record.transportScope)
      }
    }
    await transactionDone(transaction)
    for (const scope of released) {
      this.claims.delete(scope)
    }
  }

  override async quarantineSessionScope(sessionScope: string): Promise<void> {
    await super.quarantineSessionScope(this.storageSession(sessionScope))
    await super.quarantineSessionScope(sessionScope)
  }

  override async sessionHeldByAnotherOwner(): Promise<boolean> {
    // A live sibling owns its journal, not this worker's ability to connect.
    return false
  }

  override heldByAnotherOwner(
    transportScope: string,
    sessionScope: string,
    ownerId: string,
    now: number,
  ): Promise<boolean> {
    return super.heldByAnotherOwner(
      this.storageTransport(transportScope),
      this.storageSession(sessionScope),
      ownerId,
      now,
    )
  }

  override async acquireOwner(
    transportScope: string,
    sessionScope: string,
    ownerId: string,
    now: number,
    ttlMs: number,
  ): Promise<boolean> {
    return super.acquireOwner(
      this.storageTransport(transportScope),
      this.storageSession(sessionScope),
      ownerId,
      now,
      ttlMs,
    )
  }

  override async renewOwner(
    transportScope: string,
    sessionScope: string,
    ownerId: string,
    now: number,
    ttlMs: number,
  ): Promise<OwnerRenewalOutcome> {
    let outcome = await super.renewOwner(
      this.storageTransport(transportScope),
      this.storageSession(sessionScope),
      ownerId,
      now,
      ttlMs,
    )
    for (const [scope, session] of this.claims) {
      if (scope !== this.storageTransport(transportScope)) {
        const adopted = await super.renewOwner(scope, session, ownerId, now, ttlMs)
        if (adopted !== 'renewed') {
          outcome = adopted
        }
      }
    }
    return outcome
  }

  override async releaseOwner(transportScope: string, sessionScope: string, ownerId: string): Promise<void> {
    await super.releaseOwner(this.storageTransport(transportScope), this.storageSession(sessionScope), ownerId)
    for (const [scope, session] of this.claims) {
      await super.releaseOwner(scope, session, ownerId)
    }
    this.claims.clear()
  }
}

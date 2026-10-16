import {
  ConcurrentIndexedDbSyncOutbox,
  IndexedDbSyncOutbox,
  SyncOutboxUnavailableError,
  type SyncOutboxRecord,
} from './SyncTransportOutbox'

type Lease = { transportScope: string; sessionScope: string; ownerId: string; expiresAt: number }

class FakeIdbRequest<T> {
  onsuccess: (() => void) | null = null
  onerror: (() => void) | null = null
  result!: T
  error: { message: string; name?: string } | null = null
}

class FakeStore {
  constructor(private readonly rows: Map<string, Lease>) {}

  put(lease: Lease): void {
    this.rows.set(lease.transportScope, { ...lease })
  }

  get(key: string): FakeIdbRequest<Lease | undefined> {
    const request = new FakeIdbRequest<Lease | undefined>()
    queueMicrotask(() => {
      request.result = this.rows.get(key)
      request.onsuccess?.()
    })
    return request
  }

  getAll(): FakeIdbRequest<Lease[]> {
    const request = new FakeIdbRequest<Lease[]>()
    queueMicrotask(() => {
      request.result = [...this.rows.values()]
      request.onsuccess?.()
    })
    return request
  }
}

class FakeCommandStore {
  constructor(private readonly rows: Map<string, SyncOutboxRecord>) {}

  get(key: [string, string]): FakeIdbRequest<SyncOutboxRecord | undefined> {
    const request = new FakeIdbRequest<SyncOutboxRecord | undefined>()
    queueMicrotask(() => {
      request.result = this.rows.get(`${key[0]}|${key[1]}`)
      request.onsuccess?.()
    })
    return request
  }

  index(name: string): { getAll: (sessionScope: string) => FakeIdbRequest<SyncOutboxRecord[]> } {
    if (name !== 'sessionScope') {
      throw new Error('Unknown command index')
    }
    return {
      getAll: (sessionScope) => {
        const request = new FakeIdbRequest<SyncOutboxRecord[]>()
        queueMicrotask(() => {
          request.result = [...this.rows.values()]
            .filter((record) => record.sessionScope === sessionScope)
            .map((record) => ({ ...record }))
          request.onsuccess?.()
        })
        return request
      },
    }
  }

  put(record: SyncOutboxRecord): void {
    this.rows.set(`${record.sessionScope}|${record.commandId}`, { ...record })
  }

  delete(key: [string, string]): void {
    this.rows.delete(`${key[0]}|${key[1]}`)
  }
}

class FakeTransaction {
  oncomplete: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  error: Error | null = null
  private readonly errorListeners: Array<(event: Event) => void> = []
  addEventListener(type: string, listener: (event: Event) => void): void {
    if (type === 'abort') {
      this.errorListeners.push(listener)
    }
  }

  constructor(
    private readonly rows: Map<string, Lease>,
    private readonly commands: Map<string, SyncOutboxRecord>,
  ) {
    // A real transaction completes after its last request settles; a macrotask
    // is the closest ordering available here and leaves the awaits in `database()`
    // time to attach their handlers.
    setTimeout(() => {
      if (this.error) {
        this.errorListeners.forEach((listener) => listener({ target: this } as unknown as Event))
        this.onabort?.()
      } else {
        this.oncomplete?.()
      }
    }, 0)
  }

  objectStore(name: string): FakeStore | FakeCommandStore {
    return name === 'commands-v2' ? new FakeCommandStore(this.commands) : new FakeStore(this.rows)
  }
}

class FakeDatabase {
  closed = false
  onversionchange: (() => void) | null = null
  onclose: (() => void) | null = null
  failNextTransaction?: Error
  abortNextTransaction?: Error
  transactions = 0
  objectStoreNames = { contains: () => true }

  constructor(
    private readonly rows: Map<string, Lease>,
    private readonly commands: Map<string, SyncOutboxRecord>,
  ) {}

  transaction(): FakeTransaction {
    if (this.failNextTransaction) {
      const error = this.failNextTransaction
      this.failNextTransaction = undefined
      throw error
    }
    if (this.closed) {
      throw new DOMException('The database connection is closing', 'InvalidStateError')
    }
    this.transactions++
    const transaction = new FakeTransaction(this.rows, this.commands)
    transaction.error = this.abortNextTransaction ?? null
    this.abortNextTransaction = undefined
    return transaction
  }

  createObjectStore(): { createIndex: () => void } {
    return { createIndex: () => undefined }
  }

  close(): void {
    this.closed = true
  }
}

class FakeFactory {
  opens = 0
  failNextOpen = false
  blockNextOpen = false
  closeOnOpen = false
  openFailureName = 'UnknownError'
  rows = new Map<string, Lease>()
  commands = new Map<string, SyncOutboxRecord>()
  databases: FakeDatabase[] = []
  requests: Array<
    FakeIdbRequest<FakeDatabase> & { onblocked: (() => void) | null; onupgradeneeded: (() => void) | null }
  > = []

  open(): FakeIdbRequest<FakeDatabase> & { onblocked: (() => void) | null; onupgradeneeded: (() => void) | null } {
    this.opens += 1
    const failing = this.failNextOpen
    const blocking = this.blockNextOpen
    this.failNextOpen = false
    this.blockNextOpen = false
    const request = new FakeIdbRequest<FakeDatabase>() as FakeIdbRequest<FakeDatabase> & {
      onblocked: (() => void) | null
      onupgradeneeded: (() => void) | null
    }
    request.onblocked = null
    request.onupgradeneeded = null
    this.requests.push(request)
    queueMicrotask(() => {
      if (blocking) {
        request.onblocked?.()
        return
      }
      if (failing) {
        request.error = { message: 'Could not open database', name: this.openFailureName }
        request.onerror?.()
        return
      }
      const database = new FakeDatabase(this.rows, this.commands)
      database.closed = this.closeOnOpen
      this.databases.push(database)
      request.result = database
      request.onsuccess?.()
    })
    return request
  }
}

const SCOPE = 'sync-session-v1:abc|wss://sync.example.test/sockets/sync|device-1'
const SESSION = 'sync-session-v1:abc'

describe('IndexedDbSyncOutbox', () => {
  const outboxFor = (factory: FakeFactory) => new IndexedDbSyncOutbox(factory as unknown as IDBFactory)

  const command = (
    commandId: string,
    createdAt: number,
    sequence: number,
    sessionScope = SESSION,
  ): SyncOutboxRecord => ({
    sessionScope,
    transportScope: SCOPE,
    commandId,
    digest: 'a'.repeat(64),
    bytes: '{}',
    createdAt,
    sequence,
    socketOnly: true,
  })

  it('recovers the oldest unrevoked command in its session, preserving socket-only metadata', async () => {
    const factory = new FakeFactory()
    const outbox = outboxFor(factory)
    await outbox.put(command('later', 20, 1))
    await outbox.put(command('same-time-higher-sequence', 10, 3))
    await outbox.put(command('oldest', 10, 2))
    await outbox.put({ ...command('revoked', 1, 1), revoked: true })
    await outbox.put(command('other-account', 0, 0, 'another-session'))
    await expect(outbox.oldest(SESSION)).resolves.toMatchObject({ commandId: 'oldest', socketOnly: true })
    await expect(outbox.oldest('another-session')).resolves.toMatchObject({
      commandId: 'other-account',
      socketOnly: true,
    })
    await outbox.delete(SESSION, 'oldest')
    await expect(outbox.oldest(SESSION)).resolves.toMatchObject({ commandId: 'same-time-higher-sequence' })
    outbox.close()
  })

  it('quarantines every command in a revoked session without destroying another session or the transport constraint', async () => {
    const factory = new FakeFactory()
    const outbox = outboxFor(factory)
    await outbox.put(command('first', 1, 1))
    await outbox.put(command('second', 2, 2))
    await outbox.put(command('other-account', 0, 0, 'another-session'))
    await outbox.quarantineSessionScope(SESSION)
    await expect(outbox.oldest(SESSION)).resolves.toBeUndefined()
    expect(factory.commands.get(`${SESSION}|first`)).toMatchObject({ revoked: true, socketOnly: true })
    expect(factory.commands.get(`${SESSION}|second`)).toMatchObject({ revoked: true, socketOnly: true })
    await expect(outbox.oldest('another-session')).resolves.toMatchObject({
      commandId: 'other-account',
      socketOnly: true,
    })
    outbox.close()
  })

  it('does not remember an open that failed', async () => {
    const factory = new FakeFactory()
    const outbox = outboxFor(factory)
    factory.failNextOpen = true

    await expect(outbox.heldByAnotherOwner(SCOPE, SESSION, 'owner-1', 0)).rejects.toBeInstanceOf(
      SyncOutboxUnavailableError,
    )

    // The very next operation opens the store again rather than replaying the
    // rejection for the life of the worker.
    await expect(outbox.heldByAnotherOwner(SCOPE, SESSION, 'owner-1', 0)).resolves.toBe(false)
    expect(factory.opens).toBe(2)
  })

  it('reports bounded storage health for quota failures and successful command writes, never just lease reads', async () => {
    const factory = new FakeFactory()
    const report = jest.fn()
    const outbox = new IndexedDbSyncOutbox(factory as unknown as IDBFactory, report)
    factory.failNextOpen = true
    factory.openFailureName = 'QuotaExceededError'
    await expect(outbox.oldest(SESSION)).rejects.toBeInstanceOf(SyncOutboxUnavailableError)
    expect(report).toHaveBeenLastCalledWith('quota-exceeded')
    report.mockClear()
    await outbox.heldByAnotherOwner(SCOPE, SESSION, 'owner', 0)
    expect(report).not.toHaveBeenCalled()
    factory.databases[0].abortNextTransaction = new DOMException('Storage quota exceeded', 'QuotaExceededError')
    await expect(outbox.oldest(SESSION)).rejects.toMatchObject({ name: 'QuotaExceededError' })
    expect(report).toHaveBeenLastCalledWith('quota-exceeded')
    await outbox.put(command('new', 1, 1))
    expect(report).toHaveBeenLastCalledWith('write-ok')
    report.mockImplementation(() => {
      throw new Error('warning callback failed')
    })
    await expect(outbox.put(command('next', 2, 2))).resolves.toBeUndefined()
    outbox.close()
  })

  it('reports a synchronous quota failure opening IndexedDB without changing the thrown error', async () => {
    const error = new DOMException('Storage quota exceeded', 'QuotaExceededError')
    const report = jest.fn()
    const outbox = new IndexedDbSyncOutbox(
      {
        open: () => {
          throw error
        },
      } as unknown as IDBFactory,
      report,
    )
    await expect(outbox.oldest(SESSION)).rejects.toBe(error)
    expect(report).toHaveBeenCalledWith('quota-exceeded')
  })

  it('reports an upgrade blocked by another tab as the store being unavailable', async () => {
    const factory = new FakeFactory()
    const outbox = outboxFor(factory)
    factory.blockNextOpen = true

    await expect(outbox.heldByAnotherOwner(SCOPE, SESSION, 'owner-1', 0)).rejects.toBeInstanceOf(
      SyncOutboxUnavailableError,
    )
  })

  it('closes its connection when another tab upgrades the schema, then re-opens', async () => {
    const factory = new FakeFactory()
    const outbox = outboxFor(factory)
    await outbox.heldByAnotherOwner(SCOPE, SESSION, 'owner-1', 0)
    expect(factory.opens).toBe(1)

    const database = factory.databases[0]
    expect(database.onversionchange).toBeInstanceOf(Function)
    database.onversionchange?.()
    expect(database.closed).toBe(true)

    await expect(outbox.heldByAnotherOwner(SCOPE, SESSION, 'owner-1', 0)).resolves.toBe(false)
    expect(factory.opens).toBe(2)
  })

  it('reopens after an unexpected close without changing the exact pending command or dispatched marker', async () => {
    const factory = new FakeFactory()
    const outbox = outboxFor(factory)
    const pending = {
      ...command('uncertain', 10, 7),
      bytes: '{"commandId":"uncertain"}',
      operationId: 'original-action',
      dispatchedAt: 12,
    }
    await outbox.put(pending)
    const database = factory.databases[0]
    expect(database.onclose).toBeInstanceOf(Function)
    database.closed = true
    database.onclose?.()
    await expect(outbox.oldest(SESSION)).resolves.toEqual(pending)
    expect(factory.opens).toBe(2)
    expect(factory.commands.size).toBe(1)
    database.onclose?.()
    await expect(outbox.oldest(SESSION)).resolves.toEqual(pending)
    expect(factory.opens).toBe(2)
    outbox.close()
  })

  it('preserves concurrent-worker recovery claims and exact command identity across an unexpected close', async () => {
    const factory = new FakeFactory()
    const outbox = new ConcurrentIndexedDbSyncOutbox('worker-1', () => 20, factory as unknown as IDBFactory)
    const pending = {
      ...command('uncertain', 10, 7),
      bytes: '{"commandId":"uncertain"}',
      operationId: 'original-action',
      dispatchedAt: 12,
    }
    await outbox.put(pending)
    factory.databases[0].closed = true
    factory.databases[0].onclose?.()
    await expect(outbox.oldest(SESSION)).resolves.toMatchObject({
      sessionScope: pending.sessionScope,
      commandId: pending.commandId,
      bytes: pending.bytes,
      digest: pending.digest,
      sequence: pending.sequence,
      operationId: pending.operationId,
      dispatchedAt: pending.dispatchedAt,
      socketOnly: true,
    })
    expect(factory.opens).toBe(2)
    expect(factory.commands.size).toBe(1)
    outbox.close()
  })

  it('reopens once when transaction creation detects a closed handle before its close event arrives', async () => {
    const factory = new FakeFactory()
    const outbox = outboxFor(factory)
    const pending = { ...command('uncertain', 10, 7), dispatchedAt: 12 }
    await outbox.put(pending)
    factory.databases[0].closed = true
    const results = await Promise.all([outbox.oldest(SESSION), outbox.oldest(SESSION)])
    expect(results).toEqual([pending, pending])
    expect(factory.opens).toBe(2)
    expect(factory.databases[0].transactions).toBe(1)
    expect(factory.commands.size).toBe(1)
    outbox.close()
  })

  it('does not retry unrelated transaction creation failures', async () => {
    const factory = new FakeFactory()
    const outbox = outboxFor(factory)
    await outbox.heldByAnotherOwner(SCOPE, SESSION, 'owner', 0)
    factory.databases[0].failNextTransaction = new DOMException('Storage is full', 'QuotaExceededError')
    await expect(outbox.put(command('new', 1, 1))).rejects.toMatchObject({ name: 'QuotaExceededError' })
    expect(factory.opens).toBe(1)
    expect(factory.commands.size).toBe(0)
    outbox.close()
  })

  it('bounds closed-handle retries and leaves uncertain journal records intact when reopening also fails', async () => {
    const factory = new FakeFactory()
    const outbox = outboxFor(factory)
    const pending = { ...command('uncertain', 10, 1), dispatchedAt: 11 }
    await outbox.put(pending)
    factory.databases[0].closed = true
    factory.closeOnOpen = true
    await expect(outbox.oldest(SESSION)).rejects.toMatchObject({ name: 'InvalidStateError' })
    expect(factory.opens).toBe(2)
    expect(factory.commands.get(`${SESSION}|uncertain`)).toEqual(pending)
    factory.closeOnOpen = false
    await expect(outbox.oldest(SESSION)).resolves.toEqual(pending)
    outbox.close()
  })

  it('does not retry an already-created transaction that aborts', async () => {
    const factory = new FakeFactory()
    const outbox = outboxFor(factory)
    await outbox.heldByAnotherOwner(SCOPE, SESSION, 'owner', 0)
    factory.databases[0].abortNextTransaction = new DOMException('Transaction aborted', 'AbortError')
    await expect(outbox.heldByAnotherOwner(SCOPE, SESSION, 'owner', 0)).rejects.toMatchObject({ name: 'AbortError' })
    expect(factory.opens).toBe(1)
    expect(factory.databases[0].transactions).toBe(2)
    outbox.close()
  })

  it('closes late success handles from blocked attempts without evicting a newer connection', async () => {
    const factory = new FakeFactory()
    const outbox = outboxFor(factory)
    factory.blockNextOpen = true
    await expect(outbox.oldest(SESSION)).rejects.toBeInstanceOf(SyncOutboxUnavailableError)
    await expect(outbox.oldest(SESSION)).resolves.toBeUndefined()
    const late = new FakeDatabase(factory.rows, factory.commands)
    factory.requests[0].result = late
    factory.requests[0].onsuccess?.()
    expect(late.closed).toBe(true)
    await expect(outbox.oldest(SESSION)).resolves.toBeUndefined()
    expect(factory.opens).toBe(2)
    outbox.close()
  })

  it('settles superseded open callers and keeps the replacement connection cached', async () => {
    const factory = new FakeFactory()
    const outbox = outboxFor(factory)
    const superseded = expect(outbox.oldest(SESSION)).rejects.toBeInstanceOf(SyncOutboxUnavailableError)
    outbox.close()
    await expect(outbox.oldest(SESSION)).resolves.toBeUndefined()
    await superseded
    expect(factory.databases[0].closed).toBe(true)
    expect(factory.databases[1].closed).toBe(false)
    await expect(outbox.oldest(SESSION)).resolves.toBeUndefined()
    expect(factory.opens).toBe(2)
    outbox.close()
  })

  it('claims another owner only for a live lease held by a different tab in the same session', async () => {
    const factory = new FakeFactory()
    const outbox = outboxFor(factory)
    factory.rows.set(SCOPE, {
      transportScope: SCOPE,
      sessionScope: SESSION,
      ownerId: 'other-tab',
      expiresAt: 1_000,
    })

    await expect(outbox.heldByAnotherOwner(SCOPE, SESSION, 'owner-1', 500)).resolves.toBe(true)
    // Our own lease, an expired one, and another session's all leave the lane open.
    await expect(outbox.heldByAnotherOwner(SCOPE, SESSION, 'other-tab', 500)).resolves.toBe(false)
    await expect(outbox.heldByAnotherOwner(SCOPE, SESSION, 'owner-1', 1_000)).resolves.toBe(false)
    await expect(outbox.heldByAnotherOwner(SCOPE, 'sync-session-v1:zzz', 'owner-1', 500)).resolves.toBe(false)
  })

  it('answers for a session whose transport scope the caller cannot name yet', async () => {
    const factory = new FakeFactory()
    const outbox = outboxFor(factory)
    factory.rows.set('some|scope|this-tab-has-never-seen', {
      transportScope: 'some|scope|this-tab-has-never-seen',
      sessionScope: SESSION,
      ownerId: 'other-tab',
      expiresAt: 1_000,
    })

    await expect(outbox.sessionHeldByAnotherOwner(SESSION, 'owner-1', 500)).resolves.toBe(true)
    // Our own lease, an expired one, and another session's all leave the lane open.
    await expect(outbox.sessionHeldByAnotherOwner(SESSION, 'other-tab', 500)).resolves.toBe(false)
    await expect(outbox.sessionHeldByAnotherOwner(SESSION, 'owner-1', 1_000)).resolves.toBe(false)
    await expect(outbox.sessionHeldByAnotherOwner('sync-session-v1:zzz', 'owner-1', 500)).resolves.toBe(false)
  })

  it('reports an absent IndexedDB as the store being unavailable', async () => {
    const outbox = new IndexedDbSyncOutbox(undefined)

    await expect(outbox.heldByAnotherOwner(SCOPE, SESSION, 'owner-1', 0)).rejects.toBeInstanceOf(
      SyncOutboxUnavailableError,
    )
  })
})

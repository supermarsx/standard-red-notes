import { IndexedDbSyncOutbox, SyncOutboxUnavailableError, type SyncOutboxRecord } from './SyncTransportOutbox'

type Lease = { transportScope: string; sessionScope: string; ownerId: string; expiresAt: number }

class FakeIdbRequest<T> {
  onsuccess: (() => void) | null = null
  onerror: (() => void) | null = null
  result!: T
  error: { message: string } | null = null
}

class FakeStore {
  constructor(private readonly rows: Map<string, Lease>) {}

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

  constructor(
    private readonly rows: Map<string, Lease>,
    private readonly commands: Map<string, SyncOutboxRecord>,
  ) {
    // A real transaction completes after its last request settles; a macrotask
    // is the closest ordering available here and leaves the awaits in `database()`
    // time to attach their handlers.
    setTimeout(() => this.oncomplete?.(), 0)
  }

  objectStore(name: string): FakeStore | FakeCommandStore {
    return name === 'commands-v2' ? new FakeCommandStore(this.commands) : new FakeStore(this.rows)
  }
}

class FakeDatabase {
  closed = false
  onversionchange: (() => void) | null = null
  objectStoreNames = { contains: () => true }

  constructor(
    private readonly rows: Map<string, Lease>,
    private readonly commands: Map<string, SyncOutboxRecord>,
  ) {}

  transaction(): FakeTransaction {
    if (this.closed) {
      throw new Error('InvalidStateError')
    }
    return new FakeTransaction(this.rows, this.commands)
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
  rows = new Map<string, Lease>()
  commands = new Map<string, SyncOutboxRecord>()
  databases: FakeDatabase[] = []

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
    queueMicrotask(() => {
      if (blocking) {
        request.onblocked?.()
        return
      }
      if (failing) {
        request.error = { message: 'QuotaExceededError' }
        request.onerror?.()
        return
      }
      const database = new FakeDatabase(this.rows, this.commands)
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

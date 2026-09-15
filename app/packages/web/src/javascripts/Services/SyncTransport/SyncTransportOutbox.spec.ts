import { IndexedDbSyncOutbox, SyncOutboxUnavailableError } from './SyncTransportOutbox'

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

class FakeTransaction {
  oncomplete: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null

  constructor(private readonly rows: Map<string, Lease>) {
    // A real transaction completes after its last request settles; a macrotask
    // is the closest ordering available here and leaves the awaits in `database()`
    // time to attach their handlers.
    setTimeout(() => this.oncomplete?.(), 0)
  }

  objectStore(): FakeStore {
    return new FakeStore(this.rows)
  }
}

class FakeDatabase {
  closed = false
  onversionchange: (() => void) | null = null
  objectStoreNames = { contains: () => true }

  constructor(private readonly rows: Map<string, Lease>) {}

  transaction(): FakeTransaction {
    if (this.closed) {
      throw new Error('InvalidStateError')
    }
    return new FakeTransaction(this.rows)
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
      const database = new FakeDatabase(this.rows)
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

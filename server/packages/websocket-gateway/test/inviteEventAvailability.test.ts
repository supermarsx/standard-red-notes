import { describe, expect, it, vi } from 'vitest'
import {
  RedisInviteEventAvailabilityBus,
  RedisInviteEventPublisher,
  RedisInviteEventSubscriber,
  SharedInviteEventsAdapter,
} from '../src/inviteEventAvailability.js'
import { InviteEventStore, InviteEventStoreError } from '../src/inviteEventStore.js'
import { inviteAccountMember, inviteAccountOwner } from './fixtures/inviteRealtimeEvents.js'

class FakeRedisBroker {
  readonly subscriptions = new Map<string, Set<FakeRedisSubscriber>>()
  lastPublishedChannel?: string

  publisher(): RedisInviteEventPublisher {
    return {
      status: 'ready',
      publish: async (channel, message) => {
        this.lastPublishedChannel = channel
        const subscribers = [...(this.subscriptions.get(channel) ?? [])]
        for (const subscriber of subscribers) {
          subscriber.emit(channel, message)
        }
        return subscribers.length
      },
    }
  }

  subscriber(): FakeRedisSubscriber {
    return new FakeRedisSubscriber(this)
  }
}

class FakeRedisSubscriber implements RedisInviteEventSubscriber {
  readonly status = 'ready'
  private readonly listeners = new Set<(channel: string, message: string) => void>()
  private readonly channels = new Set<string>()

  constructor(private readonly broker: FakeRedisBroker) {}

  async subscribe(channel: string): Promise<void> {
    this.channels.add(channel)
    const subscribers = this.broker.subscriptions.get(channel) ?? new Set()
    subscribers.add(this)
    this.broker.subscriptions.set(channel, subscribers)
  }

  async unsubscribe(channel: string): Promise<void> {
    this.channels.delete(channel)
    const subscribers = this.broker.subscriptions.get(channel)
    subscribers?.delete(this)
    if (subscribers?.size === 0) {
      this.broker.subscriptions.delete(channel)
    }
  }

  on(_event: 'message', listener: (channel: string, message: string) => void): void {
    this.listeners.add(listener)
  }

  off(_event: 'message', listener: (channel: string, message: string) => void): void {
    this.listeners.delete(listener)
  }

  emit(channel: string, message: string): void {
    if (!this.channels.has(channel)) {
      return
    }
    for (const listener of this.listeners) {
      listener(channel, message)
    }
  }
}

describe('RedisInviteEventAvailabilityBus', () => {
  it('wakes every session across replicas while keeping unrelated accounts isolated', async () => {
    const broker = new FakeRedisBroker()
    const replicaA = new RedisInviteEventAvailabilityBus(broker.publisher(), broker.subscriber())
    const replicaB = new RedisInviteEventAvailabilityBus(broker.publisher(), broker.subscriber())
    const ownerSessionOne = vi.fn()
    const ownerSessionTwo = vi.fn()
    const memberSession = vi.fn()

    const disposeOwnerOne = replicaB.subscribeAvailability(inviteAccountOwner, ownerSessionOne)
    const disposeOwnerTwo = replicaB.subscribeAvailability(inviteAccountOwner, ownerSessionTwo)
    const disposeMember = replicaB.subscribeAvailability(inviteAccountMember, memberSession)
    await flush()
    ownerSessionOne.mockClear()
    ownerSessionTwo.mockClear()
    memberSession.mockClear()

    await replicaA.publishAvailability(inviteAccountOwner)

    expect(ownerSessionOne).toHaveBeenCalledTimes(1)
    expect(ownerSessionTwo).toHaveBeenCalledTimes(1)
    expect(memberSession).not.toHaveBeenCalled()
    expect(broker.lastPublishedChannel).not.toContain(inviteAccountOwner)

    disposeOwnerOne()
    disposeOwnerTwo()
    disposeMember()
    await Promise.all([replicaA.close(), replicaB.close()])
  })

  it('forces a reread after Redis confirms subscription to close the initial-read race', async () => {
    let confirmSubscription!: () => void
    const subscriber: RedisInviteEventSubscriber = {
      status: 'ready',
      subscribe: () => new Promise<void>((resolve) => (confirmSubscription = resolve)),
      unsubscribe: async () => undefined,
      on: () => undefined,
      off: () => undefined,
    }
    const bus = new RedisInviteEventAvailabilityBus({ status: 'ready', publish: async () => 1 }, subscriber)
    const onAvailable = vi.fn()

    bus.subscribeAvailability(inviteAccountOwner, onAvailable)
    expect(onAvailable).not.toHaveBeenCalled()
    confirmSubscription()
    await flush()

    expect(onAvailable).toHaveBeenCalledTimes(1)
    await bus.close()
  })

  it('requires shared persistence and aborts bounded adapter reads promptly', async () => {
    const availability = {
      distribution: 'shared' as const,
      ready: () => true,
      publishAvailability: async () => undefined,
      subscribeAvailability: () => () => undefined,
    }
    const processStore = { distribution: 'process' as const } as InviteEventStore
    expect(() => new SharedInviteEventsAdapter(processStore, availability)).toThrow('shared persistence')

    const sharedStore: InviteEventStore = {
      distribution: 'shared',
      ready: () => true,
      append: async () => ({ cursor: 'cursor-1', duplicate: false }),
      tail: () => new Promise<string>(() => undefined),
      readAfter: () => new Promise(() => undefined),
    }
    const adapter = new SharedInviteEventsAdapter(sharedStore, availability)
    const controller = new AbortController()
    const pending = adapter.tail(inviteAccountOwner, controller.signal)
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('fails closed on invalid configuration, subjects, listeners, readiness, and Redis publish results', async () => {
    const broker = new FakeRedisBroker()
    expect(
      () =>
        new RedisInviteEventAvailabilityBus(broker.publisher(), broker.subscriber(), { channelPrefix: 'bad prefix' }),
    ).toThrow('channel prefix')

    const unavailablePublisher = new RedisInviteEventAvailabilityBus(
      { status: 'connecting', publish: async () => 0 },
      broker.subscriber(),
    )
    expect(unavailablePublisher.ready()).toBe(false)
    // vitest 4's toMatchObject takes no type argument; `satisfies` keeps the
    // expected shape checked against InviteEventStoreError instead.
    await expect(unavailablePublisher.publishAvailability(inviteAccountOwner)).rejects.toMatchObject({
      code: 'INVITE_STORE_UNAVAILABLE',
    } satisfies Partial<InviteEventStoreError>)
    await unavailablePublisher.close()

    const unavailableSubscriber = new RedisInviteEventAvailabilityBus(broker.publisher(), {
      ...broker.subscriber(),
      status: 'connecting',
      subscribe: async () => undefined,
      unsubscribe: async () => undefined,
      on: () => undefined,
      off: () => undefined,
    })
    expect(unavailableSubscriber.ready()).toBe(false)
    expect(() => unavailableSubscriber.subscribeAvailability(inviteAccountOwner, vi.fn())).toThrow(
      'availability is not ready',
    )
    await unavailableSubscriber.close()

    const malformedPublish = new RedisInviteEventAvailabilityBus(
      { status: 'ready', publish: async () => -1 },
      broker.subscriber(),
    )
    await expect(malformedPublish.publishAvailability(inviteAccountOwner)).rejects.toMatchObject({
      code: 'INVITE_STORE_UNAVAILABLE',
    })
    expect(malformedPublish.ready()).toBe(false)
    await malformedPublish.close()

    const invalid = new RedisInviteEventAvailabilityBus(broker.publisher(), broker.subscriber())
    await expect(invalid.publishAvailability('not-a-uuid')).rejects.toMatchObject({
      code: 'INVITE_STORE_UNAVAILABLE',
    })
    expect(() => invalid.subscribeAvailability(inviteAccountOwner, undefined as never)).toThrow('listener is invalid')
    await invalid.close()
    await invalid.close()
    expect(invalid.ready()).toBe(false)
  })

  it('isolates noisy Redis messages and throwing listeners, and makes disposal idempotent', async () => {
    const broker = new FakeRedisBroker()
    const subscriber = broker.subscriber()
    const bus = new RedisInviteEventAvailabilityBus(broker.publisher(), subscriber)
    const throwing = vi.fn(() => {
      throw new Error('session closed during wakeup')
    })
    const healthy = vi.fn()
    const disposeThrowing = bus.subscribeAvailability(inviteAccountOwner, throwing)
    const disposeHealthy = bus.subscribeAvailability(inviteAccountOwner, healthy)
    await flush()
    throwing.mockClear()
    healthy.mockClear()

    const channel = [...broker.subscriptions.keys()][0]
    subscriber.emit(channel, 'noise')
    expect(throwing).not.toHaveBeenCalled()
    expect(healthy).not.toHaveBeenCalled()

    await bus.publishAvailability(inviteAccountOwner)
    expect(throwing).toHaveBeenCalledTimes(1)
    expect(healthy).toHaveBeenCalledTimes(1)

    disposeThrowing()
    disposeThrowing()
    disposeHealthy()
    await flush()
    subscriber.emit(channel, 'available')
    expect(healthy).toHaveBeenCalledTimes(1)
    await bus.close()
  })

  it('swallows unsubscribe failures on disposal and close without keeping the bus ready', async () => {
    const listeners = new Set<(channel: string, message: string) => void>()
    const subscriber: RedisInviteEventSubscriber = {
      status: 'ready',
      subscribe: async () => undefined,
      unsubscribe: async () => {
        throw new Error('redis disconnecting')
      },
      on: (_event, listener) => listeners.add(listener),
      off: (_event, listener) => listeners.delete(listener),
    }
    const bus = new RedisInviteEventAvailabilityBus({ status: 'ready', publish: async () => 0 }, subscriber)
    const firstDispose = bus.subscribeAvailability(inviteAccountOwner, vi.fn())
    bus.subscribeAvailability(inviteAccountMember, vi.fn())
    await flush()
    firstDispose()
    await flush()
    await expect(bus.close()).resolves.toBeUndefined()
    expect(bus.ready()).toBe(false)
    expect(listeners.size).toBe(0)
  })

  it('does not activate a subscription that completes after close', async () => {
    let confirm!: () => void
    const onAvailable = vi.fn()
    const subscriber: RedisInviteEventSubscriber = {
      status: 'ready',
      subscribe: () => new Promise<void>((resolve) => (confirm = resolve)),
      unsubscribe: async () => undefined,
      on: () => undefined,
      off: () => undefined,
    }
    const bus = new RedisInviteEventAvailabilityBus({ status: 'ready', publish: async () => 0 }, subscriber)
    bus.subscribeAvailability(inviteAccountOwner, onAvailable)
    const closing = bus.close()
    confirm()
    await closing
    expect(onAvailable).not.toHaveBeenCalled()
  })

  it('delegates shared readiness, successful reads, subscriptions, and pre-aborted operations', async () => {
    let storeReady = true
    let availabilityReady = true
    const replay = { previousCursor: 'cursor-1', events: [], nextCursor: 'cursor-1', hasMore: false }
    const store: InviteEventStore = {
      distribution: 'shared',
      ready: () => storeReady,
      append: async () => ({ cursor: 'cursor-1', duplicate: false }),
      tail: async () => 'cursor-1',
      readAfter: async () => replay,
    }
    const dispose = vi.fn()
    const subscribeAvailability = vi.fn(() => dispose)
    const adapter = new SharedInviteEventsAdapter(store, {
      distribution: 'shared',
      ready: () => availabilityReady,
      publishAvailability: async () => undefined,
      subscribeAvailability,
    })
    expect(adapter.ready()).toBe(true)
    storeReady = false
    expect(adapter.ready()).toBe(false)
    storeReady = true
    availabilityReady = false
    expect(adapter.ready()).toBe(false)
    availabilityReady = true

    await expect(adapter.tail(inviteAccountOwner, new AbortController().signal)).resolves.toBe('cursor-1')
    await expect(adapter.readAfter(inviteAccountOwner, 'cursor-1', 10, new AbortController().signal)).resolves.toBe(
      replay,
    )
    const callback = vi.fn()
    expect(adapter.subscribeAvailability(inviteAccountOwner, callback)).toBe(dispose)
    expect(subscribeAvailability).toHaveBeenCalledWith(inviteAccountOwner, callback)

    const aborted = new AbortController()
    aborted.abort()
    await expect(adapter.readAfter(inviteAccountOwner, 'cursor-1', 10, aborted.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })

    expect(
      () =>
        new SharedInviteEventsAdapter(store, {
          distribution: 'process',
          ready: () => true,
          publishAvailability: async () => undefined,
          subscribeAvailability: () => () => undefined,
        }),
    ).toThrow('shared persistence')
  })
})

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

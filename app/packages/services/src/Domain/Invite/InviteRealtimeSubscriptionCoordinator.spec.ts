import { InviteRealtimeBatch, InviteRealtimeEvent } from './InviteRealtimeEvent'
import {
  InviteRealtimeCheckpoint,
  InviteRealtimeCheckpointStore,
  InviteRealtimeEventConsumer,
} from './InviteRealtimeEventConsumer'
import {
  InviteRealtimeRetryScheduler,
  InviteRealtimeSubscriptionCoordinator,
  InviteRealtimeSubscriptionOptions,
  InviteRealtimeSubscriptionPort,
} from './InviteRealtimeSubscriptionCoordinator'

const sessionA = 'opaque-session-a'
const sessionB = 'opaque-session-b'
const cursor0 = 'cursor-0'
const cursor1 = 'cursor-1'

const event = (): InviteRealtimeEvent => ({
  version: 1,
  eventId: '00000000-0000-4000-8000-000000000001',
  streamPosition: cursor1,
  kind: 'subscription-invite',
  action: 'created',
  inviteUuid: '00000000-0000-4000-8000-000000000002',
  occurredAt: 1,
})

const batch = (): InviteRealtimeBatch => ({
  previousCursor: cursor0,
  events: [event()],
  nextCursor: cursor1,
  hasMore: false,
})

class MemoryCheckpointStore implements InviteRealtimeCheckpointStore {
  readonly values = new Map<string, InviteRealtimeCheckpoint>()

  async read(scope: string): Promise<InviteRealtimeCheckpoint | undefined> {
    return this.values.get(scope)
  }

  async write(scope: string, checkpoint: InviteRealtimeCheckpoint): Promise<void> {
    this.values.set(scope, structuredClone(checkpoint))
  }

  async clear(scope: string): Promise<void> {
    this.values.delete(scope)
  }
}

class FakeSubscriptionPort implements InviteRealtimeSubscriptionPort {
  readonly subscriptions: Array<{ options: InviteRealtimeSubscriptionOptions; disposed: boolean }> = []

  async subscribeInviteEvents(options: InviteRealtimeSubscriptionOptions): Promise<() => void> {
    const subscription = { options, disposed: false }
    this.subscriptions.push(subscription)
    return () => {
      subscription.disposed = true
    }
  }
}

class ManualScheduler implements InviteRealtimeRetryScheduler {
  readonly delays: number[] = []
  private readonly tasks = new Map<number, () => void>()
  private nextHandle = 1

  schedule(callback: () => void, delayMilliseconds: number): unknown {
    const handle = this.nextHandle++
    this.delays.push(delayMilliseconds)
    this.tasks.set(handle, callback)
    return handle
  }

  cancel(handle: unknown): void {
    this.tasks.delete(Number(handle))
  }

  runNext(): void {
    const next = this.tasks.entries().next().value as [number, () => void] | undefined
    if (!next) {
      throw new Error('No invite retry was scheduled.')
    }
    this.tasks.delete(next[0])
    next[1]()
  }
}

describe('InviteRealtimeSubscriptionCoordinator', () => {
  it('uses durable push delivery without snapshots, timers, or polling while healthy', async () => {
    const store = new MemoryCheckpointStore()
    store.values.set(sessionA, { cursor: cursor0, seenEventIds: [] })
    const handler = jest.fn()
    const consumer = new InviteRealtimeEventConsumer(store, handler)
    const port = new FakeSubscriptionPort()
    const scheduler = new ManualScheduler()
    const reconcileSnapshot = jest.fn()
    const coordinator = new InviteRealtimeSubscriptionCoordinator(port, consumer, {
      scheduler,
      reconcileSnapshot,
    })

    await coordinator.startSession(sessionA)
    const subscription = port.subscriptions[0]
    await expect(subscription.options.applyBatch(batch())).resolves.toBe(cursor1)

    expect(subscription.options.cursor).toBe(cursor0)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(store.values.get(sessionA)?.cursor).toBe(cursor1)
    expect(reconcileSnapshot).not.toHaveBeenCalled()
    expect(scheduler.delays).toEqual([])
  })

  it('disposes a stalled apply and retries from the unchanged durable cursor without taking a snapshot', async () => {
    const store = new MemoryCheckpointStore()
    store.values.set(sessionA, { cursor: cursor0, seenEventIds: [] })
    const handler = jest.fn().mockRejectedValueOnce(new Error('temporary apply failure')).mockResolvedValue(undefined)
    const consumer = new InviteRealtimeEventConsumer(store, handler)
    const port = new FakeSubscriptionPort()
    const scheduler = new ManualScheduler()
    const reconcileSnapshot = jest.fn()
    const coordinator = new InviteRealtimeSubscriptionCoordinator(port, consumer, {
      scheduler,
      retryBaseDelayMilliseconds: 10,
      retryMaximumDelayMilliseconds: 100,
      reconcileSnapshot,
    })

    await coordinator.startSession(sessionA)
    const first = port.subscriptions[0]
    await expect(first.options.applyBatch(batch())).rejects.toThrow('handler-failed')
    first.options.onError?.({ code: 'INVITE_APPLY_FAILED', retryable: true })

    expect(first.disposed).toBe(true)
    expect(store.values.get(sessionA)?.cursor).toBe(cursor0)
    expect(scheduler.delays).toEqual([10])
    expect(reconcileSnapshot).not.toHaveBeenCalled()

    scheduler.runNext()
    await Promise.resolve()
    const second = port.subscriptions[1]
    expect(second.options.cursor).toBe(cursor0)
    await expect(second.options.applyBatch(batch())).resolves.toBe(cursor1)
    expect(store.values.get(sessionA)?.cursor).toBe(cursor1)
  })

  it('stands down instead of reconnecting when the transport reports a permanently unavailable capability', async () => {
    const store = new MemoryCheckpointStore()
    const consumer = new InviteRealtimeEventConsumer(store, jest.fn())
    const port = new FakeSubscriptionPort()
    const scheduler = new ManualScheduler()
    const onError = jest.fn()
    const coordinator = new InviteRealtimeSubscriptionCoordinator(port, consumer, {
      scheduler,
      reconcileSnapshot: jest.fn(),
      onError,
    })

    await coordinator.startSession(sessionA)
    const subscription = port.subscriptions[0]
    subscription.options.onError?.({ code: 'CAPABILITY_UNAVAILABLE', retryable: false })

    expect(onError).toHaveBeenCalledTimes(1)
    expect(subscription.disposed).toBe(true)
    // A deployment that does not advertise the capability cannot be reached by retrying, so no
    // reconnect may be scheduled; the stream restarts on the next launch or sign-in instead.
    expect(scheduler.delays).toEqual([])
    expect(port.subscriptions).toHaveLength(1)
  })

  it('uses a strict snapshot only for server bootstrap and persists its tail before resubscribe', async () => {
    const store = new MemoryCheckpointStore()
    const consumer = new InviteRealtimeEventConsumer(store, jest.fn())
    const port = new FakeSubscriptionPort()
    const scheduler = new ManualScheduler()
    const reconcileSnapshot = jest.fn(async ({ context }) => {
      context.assertCurrent()
      return [{ key: 'application:items', revision: '7' }]
    })
    const coordinator = new InviteRealtimeSubscriptionCoordinator(port, consumer, {
      scheduler,
      reconcileSnapshot: async (input) => ({ resourceRevisions: await reconcileSnapshot(input) }),
    })

    await coordinator.startSession(sessionA)
    const subscription = port.subscriptions[0]
    expect(subscription.options.cursor).toBeUndefined()
    await subscription.options.reconcile({ reason: 'BOOTSTRAP_REQUIRED', cursor: 'cursor-tail' })

    expect(reconcileSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ sessionScope: sessionA, reason: 'BOOTSTRAP_REQUIRED', cursor: 'cursor-tail' }),
    )
    expect(store.values.get(sessionA)).toEqual({
      cursor: 'cursor-tail',
      seenEventIds: [],
      resourceRevisions: [{ key: 'application:items', revision: '7' }],
    })
    expect(scheduler.delays).toEqual([])
  })

  it('still schedules durable recovery when an error observer throws', async () => {
    const store = new MemoryCheckpointStore()
    store.values.set(sessionA, { cursor: cursor0, seenEventIds: [] })
    const consumer = new InviteRealtimeEventConsumer(store, jest.fn())
    const port = new FakeSubscriptionPort()
    const scheduler = new ManualScheduler()
    const coordinator = new InviteRealtimeSubscriptionCoordinator(port, consumer, {
      scheduler,
      reconcileSnapshot: jest.fn(),
      onError: () => {
        throw new Error('diagnostic observer failure')
      },
    })

    await coordinator.startSession(sessionA)
    expect(() => port.subscriptions[0].options.onError?.(new Error('transport failure'))).not.toThrow()
    expect(scheduler.delays).toEqual([250])
  })

  it('aborts and isolates late callbacks when the authenticated session changes', async () => {
    const store = new MemoryCheckpointStore()
    store.values.set(sessionA, { cursor: cursor0, seenEventIds: [] })
    store.values.set(sessionB, { cursor: 'cursor-b', seenEventIds: [] })
    const handler = jest.fn()
    const consumer = new InviteRealtimeEventConsumer(store, handler)
    const port = new FakeSubscriptionPort()
    const coordinator = new InviteRealtimeSubscriptionCoordinator(port, consumer, {
      reconcileSnapshot: jest.fn(),
    })

    await coordinator.startSession(sessionA)
    const stale = port.subscriptions[0]
    await coordinator.startSession(sessionB)

    expect(stale.disposed).toBe(true)
    await expect(stale.options.applyBatch(batch())).rejects.toThrow('session-changed')
    expect(handler).not.toHaveBeenCalled()
    expect(store.values.get(sessionA)?.cursor).toBe(cursor0)
    expect(consumer.getCursor(sessionB)).toBe('cursor-b')
  })
})

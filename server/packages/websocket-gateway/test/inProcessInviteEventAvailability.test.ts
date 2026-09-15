import { describe, expect, it, vi } from 'vitest'

import {
  createInProcessInviteEventComposition,
  InProcessInviteEventAvailabilityBus,
  InProcessInviteEventsAdapter,
} from '../src/inProcessInviteEventAvailability.js'
import { InMemoryInviteEventStore, type InviteEventInvalidation } from '../src/inviteEventStore.js'

const OWNER = '70000000-0000-4000-8000-000000000001'
const MEMBER = '70000000-0000-4000-8000-000000000002'
const SECRET = 'a'.repeat(32)

function flush(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve))
}

function inviteEvent(eventId: string): InviteEventInvalidation {
  return {
    version: 1,
    eventId,
    occurredAt: 1_700_000_000_000,
    kind: 'shared-vault-invite',
    action: 'created',
    inviteUuid: '60000000-0000-4000-8000-000000000001',
    sharedVaultUuid: '60000000-0000-4000-8000-000000000002',
  }
}

describe('InProcessInviteEventAvailabilityBus', () => {
  it('reports process distribution, which is what keeps a fleet off it', () => {
    const bus = new InProcessInviteEventAvailabilityBus()

    expect(bus.distribution).toBe('process')
    expect(bus.ready()).toBe(true)
  })

  it('wakes a new subscriber once, then on every publish for that account', async () => {
    const bus = new InProcessInviteEventAvailabilityBus()
    const ownerSession = vi.fn()
    const otherSession = vi.fn()

    const unsubscribe = bus.subscribeAvailability(OWNER, ownerSession)
    bus.subscribeAvailability(MEMBER, otherSession)
    // The wakeup that closes the subscribe-before-first-read race arrives on a
    // later microtask, never inside subscribeAvailability itself.
    expect(ownerSession).not.toHaveBeenCalled()
    await flush()
    expect(ownerSession).toHaveBeenCalledTimes(1)

    await bus.publishAvailability(OWNER)
    expect(ownerSession).toHaveBeenCalledTimes(2)
    expect(otherSession).toHaveBeenCalledTimes(1)

    unsubscribe()
    unsubscribe()
    await bus.publishAvailability(OWNER)
    expect(ownerSession).toHaveBeenCalledTimes(2)
    // An account nobody listens to is a no-op, not a throw.
    await expect(bus.publishAvailability(OWNER)).resolves.toBeUndefined()
  })

  it('does not let one throwing listener suppress the others', async () => {
    const bus = new InProcessInviteEventAvailabilityBus()
    const healthy = vi.fn()
    bus.subscribeAvailability(OWNER, () => {
      throw new Error('session exploded')
    })
    bus.subscribeAvailability(OWNER, healthy)
    await flush()

    await expect(bus.publishAvailability(OWNER)).resolves.toBeUndefined()
    expect(healthy).toHaveBeenCalled()
  })

  it('drops a wakeup for a subscription cancelled before it lands', async () => {
    const bus = new InProcessInviteEventAvailabilityBus()
    const session = vi.fn()

    bus.subscribeAvailability(OWNER, session)()
    await flush()

    expect(session).not.toHaveBeenCalled()
  })

  it('refuses an invalid account subject and an invalid listener', () => {
    const bus = new InProcessInviteEventAvailabilityBus()

    expect(() => bus.subscribeAvailability('not-a-uuid', vi.fn())).toThrow(/account subject is invalid/)
    expect(() => bus.subscribeAvailability(OWNER, undefined as unknown as () => void)).toThrow(/listener is invalid/)
  })

  it('stops serving once closed', async () => {
    const bus = new InProcessInviteEventAvailabilityBus()
    const session = vi.fn()
    bus.subscribeAvailability(OWNER, session)
    await bus.close()

    expect(bus.ready()).toBe(false)
    await expect(bus.publishAvailability(OWNER)).rejects.toMatchObject({ code: 'INVITE_STORE_UNAVAILABLE' })
    expect(() => bus.subscribeAvailability(OWNER, vi.fn())).toThrow(/closed/)
  })
})

describe('InProcessInviteEventsAdapter', () => {
  it('serves the durable stream and reports readiness from both halves', async () => {
    const store = new InMemoryInviteEventStore({ cursorSecret: SECRET })
    const bus = new InProcessInviteEventAvailabilityBus()
    const adapter = new InProcessInviteEventsAdapter(store, bus)
    const controller = new AbortController()

    expect(adapter.distribution).toBe('process')
    expect(adapter.ready()).toBe(true)

    const cursor = await adapter.tail(OWNER, controller.signal)
    await store.append(OWNER, inviteEvent('80000000-0000-4000-8000-000000000001'))
    const replay = await adapter.readAfter(OWNER, cursor, 10, controller.signal)
    expect(replay.events).toHaveLength(1)
    expect(replay.events[0].eventId).toBe('80000000-0000-4000-8000-000000000001')

    await bus.close()
    expect(adapter.ready()).toBe(false)
  })

  it('rejects a read whose socket has already gone away', async () => {
    const store = new InMemoryInviteEventStore({ cursorSecret: SECRET })
    const adapter = new InProcessInviteEventsAdapter(store, new InProcessInviteEventAvailabilityBus())
    const controller = new AbortController()
    controller.abort()

    await expect(adapter.tail(OWNER, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects an in-flight read when the socket goes away mid-operation', async () => {
    const controller = new AbortController()
    const never = new Promise<string>(() => undefined)
    const adapter = new InProcessInviteEventsAdapter(
      { distribution: 'process', ready: () => true, append: vi.fn(), tail: () => never, readAfter: vi.fn() },
      new InProcessInviteEventAvailabilityBus(),
    )

    const pending = adapter.tail(OWNER, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('createInProcessInviteEventComposition', () => {
  it('wakes every live session on this process when the outbox dispatches', async () => {
    const composition = createInProcessInviteEventComposition({
      store: new InMemoryInviteEventStore({ cursorSecret: SECRET }),
      availability: new InProcessInviteEventAvailabilityBus(),
      clock: () => 1_700_000_000_000,
    })
    const controller = new AbortController()
    const ownerSession = vi.fn()
    const memberSession = vi.fn()
    composition.gatewayAdapter.subscribeAvailability(OWNER, ownerSession)
    composition.gatewayAdapter.subscribeAvailability(MEMBER, memberSession)
    await flush()
    const cursor = await composition.gatewayAdapter.tail(MEMBER, controller.signal)

    await expect(
      composition.dispatcher.dispatch({
        version: 1,
        recordId: '80000000-0000-4000-8000-000000000009',
        affectedUserUuids: [OWNER, MEMBER],
        event: inviteEvent('80000000-0000-4000-8000-000000000009'),
      }),
    ).resolves.toEqual({ affectedUsers: 2, appended: 2, duplicates: 0 })

    expect(ownerSession).toHaveBeenCalledTimes(2)
    expect(memberSession).toHaveBeenCalledTimes(2)
    const replay = await composition.gatewayAdapter.readAfter(MEMBER, cursor, 10, controller.signal)
    expect(replay.events.map((event) => event.eventId)).toEqual(['80000000-0000-4000-8000-000000000009'])
    expect(composition.producer).toBeDefined()
  })
})

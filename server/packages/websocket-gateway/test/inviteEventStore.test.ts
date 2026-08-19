import { describe, expect, it, vi } from 'vitest'
import {
  appendInviteEventForAffectedUsers,
  InMemoryInviteEventStore,
  isInviteEventInvalidation,
  isInviteEventUserUuid,
  isOpaqueInviteEventCursor,
  InviteEventInvalidation,
  InviteEventStoreError,
  RedisInviteEventClient,
  RedisInviteEventStore,
  SharedVaultMembershipEventAction,
} from '../src/inviteEventStore.js'

const secret = '0123456789abcdef0123456789abcdef'
const accountA = '00000000-0000-4000-8000-000000000001'
const accountB = '00000000-0000-4000-8000-000000000002'

const redisClient = (overrides: Partial<RedisInviteEventClient> = {}): RedisInviteEventClient =>
  ({
    status: 'ready',
    get: vi.fn().mockResolvedValue(null),
    zrange: vi.fn().mockResolvedValue([]),
    zrangebyscore: vi.fn().mockResolvedValue([]),
    eval: vi.fn().mockResolvedValue(0),
    ...overrides,
  }) as RedisInviteEventClient

type SharedVaultInviteEvent = Extract<InviteEventInvalidation, { kind: 'shared-vault-invite' }>

// Overrides are scoped to the member this fixture actually builds. Partial of the
// whole union would let a caller swap in another kind's `kind`/`action` while the
// shared-vault-invite fields stayed behind, producing a value in no member at all.
const inviteEvent = (index: number, overrides: Partial<SharedVaultInviteEvent> = {}): InviteEventInvalidation => ({
  version: 1,
  eventId: `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
  kind: 'shared-vault-invite',
  action: 'created',
  inviteUuid: '10000000-0000-4000-8000-000000000001',
  sharedVaultUuid: '20000000-0000-4000-8000-000000000001',
  occurredAt: index + 1,
  ...overrides,
})

const membershipEvent = (action: SharedVaultMembershipEventAction, index: number): InviteEventInvalidation => {
  const common = {
    version: 1 as const,
    eventId: `50000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
    kind: 'shared-vault-membership' as const,
    action,
    sharedVaultUuid: '20000000-0000-4000-8000-000000000001',
    memberUserUuid: accountB,
    revision: String(index),
    occurredAt: index,
  }
  switch (action) {
    case 'invited':
      return { ...common, inviteUuid: '10000000-0000-4000-8000-000000000001', role: 'write' }
    case 'accepted':
      return {
        ...common,
        membershipUuid: '30000000-0000-4000-8000-000000000001',
        inviteUuid: '10000000-0000-4000-8000-000000000001',
        role: 'write',
      }
    case 'joined':
    case 'role-changed':
      return { ...common, membershipUuid: '30000000-0000-4000-8000-000000000001', role: 'write' }
    case 'left':
    case 'revoked':
      return { ...common, membershipUuid: '30000000-0000-4000-8000-000000000001' }
  }
}

describe('InMemoryInviteEventStore', () => {
  it('starts at the authenticated tail and replays subsequent events oldest-first', async () => {
    const store = new InMemoryInviteEventStore({ cursorSecret: secret })
    const cursor = await store.tail(accountA)
    await store.append(accountA, inviteEvent(1))
    await store.append(accountA, inviteEvent(2))

    const replay = await store.readAfter(accountA, cursor, 10)

    expect(replay.previousCursor).toBe(cursor)
    expect(replay.events.map((event) => event.eventId)).toEqual([inviteEvent(1).eventId, inviteEvent(2).eventId])
    expect(replay.nextCursor).toBe(replay.events[1].streamPosition)
    expect(replay.hasMore).toBe(false)
  })

  it('returns bounded batches and resumes exclusively from the last cursor', async () => {
    const store = new InMemoryInviteEventStore({ cursorSecret: secret })
    const initial = await store.tail(accountA)
    await store.append(accountA, inviteEvent(1))
    await store.append(accountA, inviteEvent(2))

    const first = await store.readAfter(accountA, initial, 1)
    const second = await store.readAfter(accountA, first.nextCursor, 1)

    expect(first.events).toHaveLength(1)
    expect(first.hasMore).toBe(true)
    expect(second.events.map((event) => event.eventId)).toEqual([inviteEvent(2).eventId])
    expect(second.hasMore).toBe(false)
  })

  it('deduplicates the same durable event identity without allocating another position', async () => {
    const store = new InMemoryInviteEventStore({ cursorSecret: secret })
    const initial = await store.tail(accountA)

    const first = await store.append(accountA, inviteEvent(1))
    const duplicate = await store.append(accountA, inviteEvent(1, { action: 'updated' }))

    expect(first.duplicate).toBe(false)
    expect(duplicate).toEqual({ cursor: first.cursor, duplicate: true })
    expect((await store.readAfter(accountA, initial)).events).toHaveLength(1)
  })

  it('cryptographically binds cursors to an account', async () => {
    const store = new InMemoryInviteEventStore({ cursorSecret: secret })
    const cursor = await store.tail(accountA)

    await expect(store.readAfter(accountB, cursor)).rejects.toMatchObject({
      code: 'INVITE_CURSOR_INVALID',
    } satisfies Partial<InviteEventStoreError>)
  })

  it('reports an expired cursor after bounded retention trims its successor', async () => {
    const store = new InMemoryInviteEventStore({ cursorSecret: secret, maxEventsPerUser: 1 })
    const cursor = await store.tail(accountA)
    await store.append(accountA, inviteEvent(1))
    await store.append(accountA, inviteEvent(2))

    await expect(store.readAfter(accountA, cursor)).rejects.toMatchObject({
      code: 'INVITE_CURSOR_EXPIRED',
    } satisfies Partial<InviteEventStoreError>)
  })

  it('forgets deduplication identities when their retained event is trimmed', async () => {
    const store = new InMemoryInviteEventStore({ cursorSecret: secret, maxEventsPerUser: 1 })
    await store.append(accountA, inviteEvent(1))
    await store.append(accountA, inviteEvent(2))

    await expect(store.append(accountA, inviteEvent(1))).resolves.toMatchObject({ duplicate: false })
  })

  it('rejects payloads that contain no valid data-minimal invitation shape', async () => {
    const store = new InMemoryInviteEventStore({ cursorSecret: secret })

    await expect(store.append(accountA, { ...inviteEvent(1), plaintext: 'secret' } as never)).rejects.toMatchObject({
      code: 'INVITE_STORE_UNAVAILABLE',
    } satisfies Partial<InviteEventStoreError>)
    await expect(
      // Deliberately in no union member: a subscription-invite still carrying the
      // shared-vault-invite's sharedVaultUuid. The store must reject it at runtime.
      store.append(accountA, {
        ...inviteEvent(2),
        kind: 'subscription-invite',
      } as never),
    ).rejects.toMatchObject({ code: 'INVITE_STORE_UNAVAILABLE' } satisfies Partial<InviteEventStoreError>)
  })

  it('fans every membership transition to all affected accounts for offline cursor catch-up', async () => {
    const store = new InMemoryInviteEventStore({ cursorSecret: secret })
    const cursorA = await store.tail(accountA)
    const cursorB = await store.tail(accountB)
    const actions: SharedVaultMembershipEventAction[] = [
      'invited',
      'accepted',
      'joined',
      'role-changed',
      'left',
      'revoked',
    ]

    for (const [index, action] of actions.entries()) {
      const results = await appendInviteEventForAffectedUsers(
        store,
        [accountA, accountB, accountA],
        membershipEvent(action, index + 1),
      )
      expect(results.map((result) => result.userUuid)).toEqual([accountA, accountB])
    }

    const replayA = await store.readAfter(accountA, cursorA)
    const replayB = await store.readAfter(accountB, cursorB)
    expect(replayA.events.map((event) => event.action)).toEqual(actions)
    expect(replayB.events.map((event) => event.action)).toEqual(actions)
    expect(replayA.nextCursor).not.toBe(cursorA)
    expect(replayB.nextCursor).not.toBe(cursorB)
  })

  it('replays metadata-only application invalidations and rejects embedded binaries', async () => {
    const store = new InMemoryInviteEventStore({ cursorSecret: secret })
    const cursor = await store.tail(accountA)
    const event: InviteEventInvalidation = {
      version: 1,
      eventId: '60000000-0000-4000-8000-000000000001',
      kind: 'application-state',
      action: 'invalidated',
      resource: 'files-metadata',
      revision: '1',
      occurredAt: 1,
    }

    await store.append(accountA, event)
    await expect(store.readAfter(accountA, cursor)).resolves.toMatchObject({ events: [event] })
    await expect(store.append(accountA, { ...event, binary: 'base64-body' } as never)).rejects.toMatchObject({
      code: 'INVITE_STORE_UNAVAILABLE',
    } satisfies Partial<InviteEventStoreError>)
  })

  it('rejects malformed cursors, replay limits, subjects, and cursors ahead of the stream', async () => {
    const store = new InMemoryInviteEventStore({ cursorSecret: secret })
    const validTail = await store.tail(accountA)

    for (const cursor of [
      '',
      'v2.0.signature',
      'v1.*.signature',
      `v1.${'z'.repeat(40)}.signature`,
      'v1.0.short',
      `v1.0.${'x'.repeat(43)}`,
    ]) {
      await expect(store.readAfter(accountA, cursor)).rejects.toMatchObject({
        code: 'INVITE_CURSOR_INVALID',
      } satisfies Partial<InviteEventStoreError>)
    }
    for (const limit of [0, 101, 1.5]) {
      await expect(store.readAfter(accountA, validTail, limit)).rejects.toMatchObject({
        code: 'INVITE_CURSOR_INVALID',
      } satisfies Partial<InviteEventStoreError>)
    }
    await expect(store.tail('not-a-user')).rejects.toMatchObject({
      code: 'INVITE_STORE_UNAVAILABLE',
    } satisfies Partial<InviteEventStoreError>)

    const advancedStore = new InMemoryInviteEventStore({ cursorSecret: secret })
    const ahead = (await advancedStore.append(accountA, inviteEvent(20))).cursor
    await expect(store.readAfter(accountA, ahead)).rejects.toMatchObject({
      code: 'INVITE_CURSOR_INVALID',
    } satisfies Partial<InviteEventStoreError>)
  })

  it('validates constructor bounds and affected-account fanout before writing', async () => {
    expect(() => new InMemoryInviteEventStore({ cursorSecret: 'too-short' })).toThrow(
      'Invite cursor secret must contain at least 32 bytes.',
    )
    expect(() => new InMemoryInviteEventStore({ cursorSecret: secret, maxEventsPerUser: 0 })).toThrow(
      'maxEventsPerUser must be a positive safe integer.',
    )
    expect(
      () =>
        new RedisInviteEventStore(redisClient(), {
          cursorSecret: secret,
          retentionMilliseconds: 1.5,
        }),
    ).toThrow('retentionMilliseconds must be a positive safe integer.')

    const store = new InMemoryInviteEventStore({ cursorSecret: secret })
    await expect(appendInviteEventForAffectedUsers(store, [], inviteEvent(21))).rejects.toMatchObject({
      code: 'INVITE_STORE_UNAVAILABLE',
    })
    const tooManyUsers = Array.from(
      { length: 1_001 },
      (_, index) => `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
    )
    await expect(appendInviteEventForAffectedUsers(store, tooManyUsers, inviteEvent(22))).rejects.toMatchObject({
      code: 'INVITE_STORE_UNAVAILABLE',
    })
    await expect(
      appendInviteEventForAffectedUsers(store, [accountA, 'not-a-user'], inviteEvent(23)),
    ).rejects.toMatchObject({ code: 'INVITE_STORE_UNAVAILABLE' })
  })
})

describe('invite event validation', () => {
  const subscriptionEvent = {
    version: 1,
    eventId: '70000000-0000-4000-8000-000000000001',
    kind: 'subscription-invite',
    action: 'updated',
    inviteUuid: '10000000-0000-4000-8000-000000000001',
    occurredAt: 1,
  } as const
  const applicationEvent = {
    version: 1,
    eventId: '60000000-0000-4000-8000-000000000001',
    kind: 'application-state',
    action: 'updated',
    resource: 'items',
    revision: '1',
    occurredAt: 1,
  } as const

  it('accepts every canonical event family and public identifier boundary', () => {
    expect(isInviteEventInvalidation(inviteEvent(1))).toBe(true)
    expect(isInviteEventInvalidation(subscriptionEvent)).toBe(true)
    expect(isInviteEventInvalidation(membershipEvent('accepted', 2))).toBe(true)
    expect(isInviteEventInvalidation(applicationEvent)).toBe(true)
    expect(
      isInviteEventInvalidation({
        ...applicationEvent,
        action: 'invalidated',
        resource: 'subscriptions',
        resourceUuid: accountA,
      }),
    ).toBe(true)

    expect(isInviteEventUserUuid(accountA)).toBe(true)
    expect(isInviteEventUserUuid('not-a-user')).toBe(false)
    expect(isInviteEventUserUuid(1)).toBe(false)
    expect(isOpaqueInviteEventCursor('cursor')).toBe(true)
    expect(isOpaqueInviteEventCursor('')).toBe(false)
    expect(isOpaqueInviteEventCursor(1)).toBe(false)
    expect(isOpaqueInviteEventCursor('x'.repeat(2_049))).toBe(false)
  })

  it('rejects malformed base and invite-family fields without accepting extra payload data', () => {
    const invalid: unknown[] = [
      null,
      [],
      'event',
      { ...inviteEvent(2), version: 2 },
      { ...inviteEvent(2), eventId: 1 },
      { ...inviteEvent(2), eventId: 'invalid' },
      { ...inviteEvent(2), kind: 1 },
      { ...inviteEvent(2), kind: 'unknown' },
      { ...inviteEvent(2), occurredAt: 1.5 },
      { ...inviteEvent(2), occurredAt: 0 },
      { ...inviteEvent(2), plaintext: 'must-not-pass' },
      { ...inviteEvent(2), action: 1 },
      { ...inviteEvent(2), action: 'unknown' },
      { ...inviteEvent(2), inviteUuid: 1 },
      { ...inviteEvent(2), inviteUuid: 'invalid' },
      { ...inviteEvent(2), sharedVaultUuid: undefined },
      { ...subscriptionEvent, plaintext: 'must-not-pass' },
      { ...subscriptionEvent, action: 1 },
      { ...subscriptionEvent, action: 'unknown' },
      { ...subscriptionEvent, inviteUuid: undefined },
    ]

    for (const event of invalid) {
      expect(isInviteEventInvalidation(event)).toBe(false)
    }
  })

  it('enforces action-dependent membership and application-state fields', () => {
    const accepted = membershipEvent('accepted', 3)
    const invited = membershipEvent('invited', 4)
    const left = membershipEvent('left', 5)
    const roleChanged = membershipEvent('role-changed', 6)
    const invalid: unknown[] = [
      { ...accepted, plaintext: 'must-not-pass' },
      { ...accepted, action: 1 },
      { ...accepted, action: 'unknown' },
      { ...accepted, sharedVaultUuid: 'invalid' },
      { ...accepted, memberUserUuid: undefined },
      { ...accepted, revision: 1 },
      { ...accepted, revision: '0' },
      { ...accepted, membershipUuid: undefined },
      { ...accepted, inviteUuid: undefined },
      { ...accepted, role: undefined },
      { ...invited, membershipUuid: accountA },
      { ...invited, inviteUuid: undefined },
      { ...invited, role: undefined },
      { ...left, inviteUuid: accountA },
      { ...left, role: 'read' },
      { ...roleChanged, role: 1 },
      { ...roleChanged, role: 'owner' },
      { ...applicationEvent, plaintext: 'must-not-pass' },
      { ...applicationEvent, action: 1 },
      { ...applicationEvent, action: 'unknown' },
      { ...applicationEvent, resource: 1 },
      { ...applicationEvent, resource: 'unknown' },
      { ...applicationEvent, resourceUuid: 1 },
      { ...applicationEvent, resourceUuid: 'invalid' },
      { ...applicationEvent, revision: undefined },
      { ...applicationEvent, revision: '0' },
    ]

    for (const event of invalid) {
      expect(isInviteEventInvalidation(event)).toBe(false)
    }
  })
})

describe('RedisInviteEventStore', () => {
  it('fails closed when shared state is not ready', async () => {
    const redis = { status: 'connecting' } as RedisInviteEventClient
    const store = new RedisInviteEventStore(redis, { cursorSecret: secret })

    expect(store.ready()).toBe(false)
    await expect(store.tail(accountA)).rejects.toMatchObject({
      code: 'INVITE_STORE_UNAVAILABLE',
    } satisfies Partial<InviteEventStoreError>)
  })

  it('uses subject-hashed Redis keys and returns the atomic append cursor', async () => {
    const evalCommand = vi.fn().mockResolvedValue(['1', 1])
    const redis = {
      status: 'ready',
      eval: evalCommand,
    } as unknown as RedisInviteEventClient
    const store = new RedisInviteEventStore(redis, { cursorSecret: secret })

    const result = await store.append(accountA, inviteEvent(1))

    expect(result.duplicate).toBe(false)
    expect(result.cursor).toMatch(/^v1\.1\./u)
    const args = evalCommand.mock.calls[0]
    expect(args[2]).not.toContain(accountA)
    expect(args[3]).not.toContain(accountA)
    expect(args[4]).not.toContain(accountA)
  })

  it('prunes by event age even while the stream remains active', async () => {
    let now = 1_000
    let counter = 0
    const rows: Array<{ position: number; serialized: string; appendedAt: number }> = []
    const redis = {
      status: 'ready',
      get: vi.fn(async () => (counter === 0 ? null : String(counter))),
      zrange: vi.fn(async (_key: string, start: number, stop: number) => {
        const selected = rows.slice(start, stop + 1)
        return selected.flatMap((row) => [row.serialized, String(row.position)])
      }),
      zrangebyscore: vi.fn(async (_key: string, minimum: string, _maximum: string, ...args: unknown[]) => {
        const after = Number(minimum.slice(1))
        const count = Number(args.at(-1))
        return rows
          .filter((row) => row.position > after)
          .slice(0, count)
          .flatMap((row) => [row.serialized, String(row.position)])
      }),
      eval: vi.fn(async (script: string, _numberOfKeys: number, ...args: Array<string | number>) => {
        if (script.includes('SRN_INVITE_EVENT_APPEND_V1')) {
          const serialized = String(args[4])
          const retention = Number(args[5])
          const appendedAt = Number(args[7])
          rows.splice(0, rows.length, ...rows.filter((row) => row.appendedAt > appendedAt - retention))
          counter += 1
          rows.push({ position: counter, serialized, appendedAt })
          return [String(counter), 1]
        }
        const retention = Number(args[2])
        const pruneAt = Number(args[3])
        const retained = rows.filter((row) => row.appendedAt > pruneAt - retention)
        const removed = rows.length - retained.length
        rows.splice(0, rows.length, ...retained)
        return removed
      }),
    } as unknown as RedisInviteEventClient
    const store = new RedisInviteEventStore(redis, {
      cursorSecret: secret,
      retentionMilliseconds: 100,
      clock: () => now,
    })
    const cursor = await store.tail(accountA)
    await store.append(accountA, inviteEvent(1))

    now = 1_101
    await expect(store.readAfter(accountA, cursor)).rejects.toMatchObject({
      code: 'INVITE_CURSOR_EXPIRED',
    } satisfies Partial<InviteEventStoreError>)
  })

  it('fails closed on Redis append errors and malformed atomic results', async () => {
    const backendFailure = new Error('redis unavailable')
    await expect(
      new RedisInviteEventStore(redisClient({ eval: vi.fn().mockRejectedValue(backendFailure) }), {
        cursorSecret: secret,
      }).append(accountA, inviteEvent(30)),
    ).rejects.toMatchObject({ code: 'INVITE_STORE_UNAVAILABLE', cause: backendFailure })

    for (const result of [undefined, ['1'], ['invalid', 1], ['9007199254740992', 1], ['1', 2]]) {
      const store = new RedisInviteEventStore(redisClient({ eval: vi.fn().mockResolvedValue(result) }), {
        cursorSecret: secret,
      })
      await expect(store.append(accountA, inviteEvent(31))).rejects.toMatchObject({
        code: 'INVITE_STORE_UNAVAILABLE',
      })
    }

    const duplicateStore = new RedisInviteEventStore(redisClient({ eval: vi.fn().mockResolvedValue([1, '0']) }), {
      cursorSecret: secret,
    })
    await expect(duplicateStore.append(accountA, inviteEvent(32))).resolves.toMatchObject({ duplicate: true })
    await expect(duplicateStore.append('not-a-user', inviteEvent(33))).rejects.toMatchObject({
      code: 'INVITE_STORE_UNAVAILABLE',
    })
  })

  it('fails closed on Redis tail transport errors and malformed counters', async () => {
    const backendFailure = new Error('redis unavailable')
    await expect(
      new RedisInviteEventStore(redisClient({ get: vi.fn().mockRejectedValue(backendFailure) }), {
        cursorSecret: secret,
      }).tail(accountA),
    ).rejects.toMatchObject({ code: 'INVITE_STORE_UNAVAILABLE', cause: backendFailure })
    await expect(
      new RedisInviteEventStore(redisClient({ get: vi.fn().mockResolvedValue('not-a-position') }), {
        cursorSecret: secret,
      }).tail(accountA),
    ).rejects.toMatchObject({ code: 'INVITE_STORE_UNAVAILABLE' })
    await expect(new RedisInviteEventStore(redisClient(), { cursorSecret: secret }).tail(accountA)).resolves.toMatch(
      /^v1\.0\./u,
    )
  })

  it('validates Redis replay metadata and stored rows before exposing them', async () => {
    const initial = await new InMemoryInviteEventStore({ cursorSecret: secret }).tail(accountA)
    const serialized = JSON.stringify(inviteEvent(40))
    const cases: Array<Partial<RedisInviteEventClient>> = [
      { eval: vi.fn().mockRejectedValue(new Error('redis unavailable')) },
      { get: vi.fn().mockResolvedValue('invalid') },
      { get: vi.fn().mockResolvedValue('1'), zrange: vi.fn().mockResolvedValue([serialized]) },
      { get: vi.fn().mockResolvedValue('1'), zrange: vi.fn().mockResolvedValue([serialized, 'invalid']) },
      { get: vi.fn().mockResolvedValue('1') },
      {
        get: vi.fn().mockResolvedValue('2'),
        zrange: vi.fn().mockResolvedValue([serialized, '2']),
      },
      {
        get: vi.fn().mockResolvedValue('1'),
        zrange: vi.fn().mockResolvedValue([serialized, '1']),
        zrangebyscore: vi.fn().mockResolvedValue([serialized]),
      },
      {
        get: vi.fn().mockResolvedValue('1'),
        zrange: vi.fn().mockResolvedValue([serialized, '1']),
        zrangebyscore: vi.fn().mockResolvedValue([serialized, 'invalid']),
      },
      {
        get: vi.fn().mockResolvedValue('1'),
        zrange: vi.fn().mockResolvedValue([serialized, '1']),
        zrangebyscore: vi.fn().mockResolvedValue(['{', '1']),
      },
      {
        get: vi.fn().mockResolvedValue('1'),
        zrange: vi.fn().mockResolvedValue([serialized, '1']),
        zrangebyscore: vi.fn().mockResolvedValue([JSON.stringify({ ...inviteEvent(40), plaintext: 'secret' }), '1']),
      },
    ]

    for (const overrides of cases) {
      const store = new RedisInviteEventStore(redisClient(overrides), { cursorSecret: secret })
      await expect(store.readAfter(accountA, initial)).rejects.toMatchObject({
        code: expect.stringMatching(/^INVITE_(CURSOR_EXPIRED|STORE_UNAVAILABLE)$/u),
      })
    }
  })

  it('rejects cursors ahead of Redis and bounds successful replay batches', async () => {
    const cursorStore = new InMemoryInviteEventStore({ cursorSecret: secret })
    const initial = await cursorStore.tail(accountA)
    const ahead = (await cursorStore.append(accountA, inviteEvent(50))).cursor

    await expect(
      new RedisInviteEventStore(redisClient(), { cursorSecret: secret }).readAfter(accountA, ahead),
    ).rejects.toMatchObject({ code: 'INVITE_CURSOR_INVALID' })

    const first = JSON.stringify(inviteEvent(51))
    const second = JSON.stringify(inviteEvent(52))
    const store = new RedisInviteEventStore(
      redisClient({
        get: vi.fn().mockResolvedValue('2'),
        zrange: vi.fn().mockResolvedValue([first, '1']),
        zrangebyscore: vi.fn().mockResolvedValue([first, '1', second, '2']),
      }),
      { cursorSecret: secret, keyPrefix: 'test:invite:' },
    )
    const replay = await store.readAfter(accountA, initial, 1)

    expect(replay.events).toHaveLength(1)
    expect(replay.events[0]).toMatchObject(inviteEvent(51))
    expect(replay.nextCursor).toBe(replay.events[0].streamPosition)
    expect(replay.hasMore).toBe(true)
  })
})

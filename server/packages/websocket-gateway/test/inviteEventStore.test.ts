import { describe, expect, it, vi } from 'vitest'
import {
  appendInviteEventForAffectedUsers,
  InMemoryInviteEventStore,
  InviteEventInvalidation,
  InviteEventStoreError,
  RedisInviteEventClient,
  RedisInviteEventStore,
  SharedVaultMembershipEventAction,
} from '../src/inviteEventStore.js'

const secret = '0123456789abcdef0123456789abcdef'
const accountA = '00000000-0000-4000-8000-000000000001'
const accountB = '00000000-0000-4000-8000-000000000002'

const inviteEvent = (index: number, overrides: Partial<InviteEventInvalidation> = {}): InviteEventInvalidation => ({
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

    await expect(store.readAfter(accountB, cursor)).rejects.toMatchObject<Partial<InviteEventStoreError>>({
      code: 'INVITE_CURSOR_INVALID',
    })
  })

  it('reports an expired cursor after bounded retention trims its successor', async () => {
    const store = new InMemoryInviteEventStore({ cursorSecret: secret, maxEventsPerUser: 1 })
    const cursor = await store.tail(accountA)
    await store.append(accountA, inviteEvent(1))
    await store.append(accountA, inviteEvent(2))

    await expect(store.readAfter(accountA, cursor)).rejects.toMatchObject<Partial<InviteEventStoreError>>({
      code: 'INVITE_CURSOR_EXPIRED',
    })
  })

  it('forgets deduplication identities when their retained event is trimmed', async () => {
    const store = new InMemoryInviteEventStore({ cursorSecret: secret, maxEventsPerUser: 1 })
    await store.append(accountA, inviteEvent(1))
    await store.append(accountA, inviteEvent(2))

    await expect(store.append(accountA, inviteEvent(1))).resolves.toMatchObject({ duplicate: false })
  })

  it('rejects payloads that contain no valid data-minimal invitation shape', async () => {
    const store = new InMemoryInviteEventStore({ cursorSecret: secret })

    await expect(store.append(accountA, { ...inviteEvent(1), plaintext: 'secret' } as never)).rejects.toMatchObject<
      Partial<InviteEventStoreError>
    >({ code: 'INVITE_STORE_UNAVAILABLE' })
    await expect(
      store.append(accountA, {
        ...inviteEvent(2),
        kind: 'subscription-invite',
      }),
    ).rejects.toMatchObject<Partial<InviteEventStoreError>>({ code: 'INVITE_STORE_UNAVAILABLE' })
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
    await expect(store.append(accountA, { ...event, binary: 'base64-body' } as never)).rejects.toMatchObject<
      Partial<InviteEventStoreError>
    >({ code: 'INVITE_STORE_UNAVAILABLE' })
  })
})

describe('RedisInviteEventStore', () => {
  it('fails closed when shared state is not ready', async () => {
    const redis = { status: 'connecting' } as RedisInviteEventClient
    const store = new RedisInviteEventStore(redis, { cursorSecret: secret })

    expect(store.ready()).toBe(false)
    await expect(store.tail(accountA)).rejects.toMatchObject<Partial<InviteEventStoreError>>({
      code: 'INVITE_STORE_UNAVAILABLE',
    })
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
    await expect(store.readAfter(accountA, cursor)).rejects.toMatchObject<Partial<InviteEventStoreError>>({
      code: 'INVITE_CURSOR_EXPIRED',
    })
  })
})

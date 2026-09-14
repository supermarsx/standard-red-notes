import {
  InviteRealtimeCheckpoint,
  InviteRealtimeCheckpointStore,
  InviteRealtimeEventConsumer,
  getInviteRealtimeRecoveryAction,
} from './InviteRealtimeEventConsumer'
import { InviteRealtimeBatch, InviteRealtimeEvent, SharedVaultInviteRealtimeEvent } from './InviteRealtimeEvent'

const accountA = 'account-a'
const accountB = 'account-b'
const cursor0 = 'cursor-0'
const cursor1 = 'cursor-1'
const cursor2 = 'cursor-2'

const event = (overrides: Partial<SharedVaultInviteRealtimeEvent> = {}): SharedVaultInviteRealtimeEvent => ({
  version: 1,
  eventId: '00000000-0000-4000-8000-000000000001',
  streamPosition: cursor1,
  kind: 'shared-vault-invite',
  action: 'created',
  inviteUuid: '00000000-0000-4000-8000-000000000002',
  sharedVaultUuid: '00000000-0000-4000-8000-000000000003',
  occurredAt: 1,
  ...overrides,
})

const batch = (events: InviteRealtimeEvent[], overrides: Partial<InviteRealtimeBatch> = {}): InviteRealtimeBatch => ({
  previousCursor: cursor0,
  events,
  nextCursor: events[events.length - 1]?.streamPosition ?? cursor0,
  hasMore: false,
  ...overrides,
})

class MemoryStore implements InviteRealtimeCheckpointStore {
  readonly values = new Map<string, InviteRealtimeCheckpoint>()
  failWrites = false

  async read(scope: string): Promise<InviteRealtimeCheckpoint | undefined> {
    const value = this.values.get(scope)
    return value
      ? {
          cursor: value.cursor,
          seenEventIds: [...value.seenEventIds],
          ...(value.resourceRevisions
            ? { resourceRevisions: value.resourceRevisions.map((entry) => ({ ...entry })) }
            : {}),
        }
      : undefined
  }

  async write(scope: string, value: InviteRealtimeCheckpoint): Promise<void> {
    if (this.failWrites) {
      throw new Error('disk unavailable')
    }
    this.values.set(scope, {
      cursor: value.cursor,
      seenEventIds: [...value.seenEventIds],
      ...(value.resourceRevisions ? { resourceRevisions: value.resourceRevisions.map((entry) => ({ ...entry })) } : {}),
    })
  }

  async clear(scope: string): Promise<void> {
    this.values.delete(scope)
  }
}

describe('InviteRealtimeEventConsumer', () => {
  it('applies an ordered batch, persists its cursor, and returns ACK only after persistence', async () => {
    const store = new MemoryStore()
    store.values.set(accountA, { cursor: cursor0, seenEventIds: [] })
    const handled: string[] = []
    const consumer = new InviteRealtimeEventConsumer(store, async (entries) => {
      handled.push(...entries.map((entry) => entry.eventId))
    })
    await consumer.beginSession(accountA)

    const result = await consumer.consume(accountA, batch([event()]))

    expect(result).toEqual({ status: 'applied', ackCursor: cursor1, applied: 1, duplicates: 0, hasMore: false })
    expect(handled).toEqual(['00000000-0000-4000-8000-000000000001'])
    expect(store.values.get(accountA)).toEqual({
      cursor: cursor1,
      seenEventIds: ['00000000-0000-4000-8000-000000000001'],
    })
  })

  it('deduplicates a replayed event while still advancing the stream cursor', async () => {
    const store = new MemoryStore()
    store.values.set(accountA, {
      cursor: cursor0,
      seenEventIds: ['00000000-0000-4000-8000-000000000001'],
    })
    const handler = jest.fn()
    const consumer = new InviteRealtimeEventConsumer(store, handler)
    await consumer.beginSession(accountA)

    const result = await consumer.consume(accountA, batch([event()]))

    expect(result).toMatchObject({ status: 'applied', ackCursor: cursor1, applied: 0, duplicates: 1 })
    expect(handler).not.toHaveBeenCalled()
  })

  it('ACKs the exact checkpointed batch replayed after a reconnect without reapplying it', async () => {
    const store = new MemoryStore()
    store.values.set(accountA, {
      cursor: cursor1,
      seenEventIds: ['00000000-0000-4000-8000-000000000001'],
    })
    const handler = jest.fn()
    const consumer = new InviteRealtimeEventConsumer(store, handler)
    await consumer.beginSession(accountA)

    await expect(consumer.consume(accountA, batch([event()]))).resolves.toEqual({
      status: 'applied',
      ackCursor: cursor1,
      applied: 0,
      duplicates: 1,
      hasMore: false,
    })
    expect(handler).not.toHaveBeenCalled()
    expect(store.values.get(accountA)?.cursor).toBe(cursor1)
  })

  it('does not accept an older or partially-known batch as a reconnect replay', async () => {
    const store = new MemoryStore()
    store.values.set(accountA, {
      cursor: cursor2,
      seenEventIds: ['00000000-0000-4000-8000-000000000001'],
    })
    const handler = jest.fn()
    const consumer = new InviteRealtimeEventConsumer(store, handler)
    await consumer.beginSession(accountA)

    await expect(consumer.consume(accountA, batch([event()]))).resolves.toEqual({
      status: 'reconcile',
      reason: 'cursor-gap',
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('deduplicates repeated event identities within one batch', async () => {
    const store = new MemoryStore()
    store.values.set(accountA, { cursor: cursor0, seenEventIds: [] })
    const handler = jest.fn()
    const consumer = new InviteRealtimeEventConsumer(store, handler)
    await consumer.beginSession(accountA)

    const result = await consumer.consume(accountA, batch([event(), event({ streamPosition: cursor2 })]))

    expect(result).toEqual({ status: 'applied', ackCursor: cursor2, applied: 1, duplicates: 1, hasMore: false })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(
      [event()],
      expect.objectContaining({ sessionScope: accountA, sessionEpoch: expect.any(Number), signal: expect.anything() }),
    )
  })

  it('fails closed on a cursor gap without applying or checkpointing the batch', async () => {
    const store = new MemoryStore()
    store.values.set(accountA, { cursor: cursor0, seenEventIds: [] })
    const handler = jest.fn()
    const consumer = new InviteRealtimeEventConsumer(store, handler)
    await consumer.beginSession(accountA)

    await expect(
      consumer.consume(accountA, batch([event()], { previousCursor: 'unexpected-cursor' })),
    ).resolves.toEqual({ status: 'reconcile', reason: 'cursor-gap' })
    expect(handler).not.toHaveBeenCalled()
    expect(store.values.get(accountA)?.cursor).toBe(cursor0)
  })

  it('rejects malformed batches before invoking invite services', async () => {
    const store = new MemoryStore()
    store.values.set(accountA, { cursor: cursor0, seenEventIds: [] })
    const handler = jest.fn()
    const consumer = new InviteRealtimeEventConsumer(store, handler)
    await consumer.beginSession(accountA)

    await expect(
      consumer.consume(accountA, { ...batch([event()]), events: [{ ...event(), plaintext: 'secret' }] }),
    ).resolves.toEqual({ status: 'reconcile', reason: 'invalid-batch' })
    expect(handler).not.toHaveBeenCalled()

    await expect(consumer.consume(accountA, batch([], { hasMore: true }))).resolves.toEqual({
      status: 'reconcile',
      reason: 'invalid-batch',
    })

    await expect(
      consumer.consume(accountA, {
        previousCursor: cursor0,
        events: [{ ...event(), kind: 'subscription-invite', sharedVaultUuid: event().sharedVaultUuid }],
        nextCursor: cursor1,
        hasMore: false,
      }),
    ).resolves.toEqual({ status: 'reconcile', reason: 'invalid-batch' })
  })

  it('does not ACK when the handler or durable checkpoint fails', async () => {
    const store = new MemoryStore()
    store.values.set(accountA, { cursor: cursor0, seenEventIds: [] })
    const failingHandler = new InviteRealtimeEventConsumer(store, async () => {
      throw new Error('reload failed')
    })
    await failingHandler.beginSession(accountA)
    await expect(failingHandler.consume(accountA, batch([event()]))).resolves.toEqual({
      status: 'reconcile',
      reason: 'handler-failed',
    })
    expect(store.values.get(accountA)?.cursor).toBe(cursor0)

    const consumer = new InviteRealtimeEventConsumer(store, async () => undefined)
    await consumer.beginSession(accountA)
    store.failWrites = true
    await expect(consumer.consume(accountA, batch([event()]))).resolves.toEqual({
      status: 'reconcile',
      reason: 'checkpoint-failed',
    })
    expect(store.values.get(accountA)?.cursor).toBe(cursor0)
  })

  it('isolates accounts and rejects a late batch after a session switch', async () => {
    const store = new MemoryStore()
    store.values.set(accountA, { cursor: cursor0, seenEventIds: [] })
    store.values.set(accountB, { cursor: cursor2, seenEventIds: [] })
    const handler = jest.fn()
    const consumer = new InviteRealtimeEventConsumer(store, handler)
    await consumer.beginSession(accountA)
    await consumer.beginSession(accountB)

    await expect(consumer.consume(accountA, batch([event()]))).resolves.toEqual({
      status: 'reconcile',
      reason: 'session-changed',
    })
    expect(handler).not.toHaveBeenCalled()
    expect(store.values.get(accountA)?.cursor).toBe(cursor0)
    expect(consumer.getCursor(accountB)).toBe(cursor2)
  })

  it('detects a session switch that happens while an event handler is awaiting', async () => {
    const store = new MemoryStore()
    store.values.set(accountA, { cursor: cursor0, seenEventIds: [] })
    store.values.set(accountB, { cursor: cursor2, seenEventIds: [] })
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let sideEffects = 0
    const consumer = new InviteRealtimeEventConsumer(store, async (_events, context) => {
      await blocked
      context.assertCurrent()
      sideEffects += 1
    })
    await consumer.beginSession(accountA)

    const inFlight = consumer.consume(accountA, batch([event()]))
    await Promise.resolve()
    await consumer.beginSession(accountB)
    release()

    await expect(inFlight).resolves.toEqual({ status: 'reconcile', reason: 'session-changed' })
    expect(sideEffects).toBe(0)
    expect(store.values.get(accountA)?.cursor).toBe(cursor0)
  })

  it('clears a malformed saved checkpoint and requires authoritative reconciliation', async () => {
    const store = new MemoryStore()
    store.values.set(accountA, { cursor: '', seenEventIds: [] })
    const consumer = new InviteRealtimeEventConsumer(store, jest.fn())

    await expect(consumer.beginSession(accountA)).resolves.toBeUndefined()
    expect(store.values.has(accountA)).toBe(false)
    await consumer.resetAfterReconciliation(accountA, cursor0)
    expect(consumer.getCursor(accountA)).toBe(cursor0)
  })

  it('replays offline membership revisions in order and restores the durable revision fence', async () => {
    const store = new MemoryStore()
    store.values.set(accountA, { cursor: cursor0, seenEventIds: [] })
    const membership = (revision: string, position: string, id: string): InviteRealtimeEvent => ({
      version: 1,
      eventId: id,
      streamPosition: position,
      kind: 'shared-vault-membership',
      action: 'joined',
      sharedVaultUuid: '10000000-0000-4000-8000-000000000001',
      memberUserUuid: '20000000-0000-4000-8000-000000000001',
      membershipUuid: '30000000-0000-4000-8000-000000000001',
      role: 'write',
      revision,
      occurredAt: Number(revision),
    })
    const first = membership('1789150108395094', cursor1, '00000000-0000-4000-8000-000000000011')
    const second = membership('1789150108500000', cursor2, '00000000-0000-4000-8000-000000000012')
    const handled: InviteRealtimeEvent[] = []
    const consumer = new InviteRealtimeEventConsumer(store, (events) => {
      handled.push(...events)
    })
    await consumer.beginSession(accountA)

    await expect(consumer.consume(accountA, batch([first, second]))).resolves.toMatchObject({
      status: 'applied',
      ackCursor: cursor2,
      applied: 2,
    })
    expect(handled).toEqual([first, second])
    expect(store.values.get(accountA)?.resourceRevisions).toEqual([
      {
        key: 'membership:30000000-0000-4000-8000-000000000001',
        revision: '1789150108500000',
      },
    ])

    const restoredHandler = jest.fn()
    const restored = new InviteRealtimeEventConsumer(store, restoredHandler)
    await restored.beginSession(accountA)
    const stale = membership('1789150108500000', 'cursor-3', '00000000-0000-4000-8000-000000000013')
    await expect(restored.consume(accountA, batch([stale], { previousCursor: cursor2 }))).resolves.toMatchObject({
      status: 'applied',
      applied: 0,
      duplicates: 1,
      ackCursor: 'cursor-3',
    })
    expect(restoredHandler).not.toHaveBeenCalled()
  })

  /**
   * Production membership revisions are `String(<microsecond timestamp of the
   * mutation>)` stamped per membership row (C12), not a per-vault counter. This
   * is the t90-e7 scenario: an older member's revocation carries a timestamp
   * older than a newer member's acceptance, and must still be applied.
   */
  it('applies an older member’s revocation and a non-contiguous newer revision under the per-membership fence', async () => {
    const store = new MemoryStore()
    store.values.set(accountA, { cursor: cursor0, seenEventIds: [] })
    const vault = '10000000-0000-4000-8000-000000000001'
    const memberA = '20000000-0000-4000-8000-00000000000a'
    const memberB = '20000000-0000-4000-8000-00000000000b'
    const membershipA = '30000000-0000-4000-8000-00000000000a'
    const membershipB = '30000000-0000-4000-8000-00000000000b'
    const handled: InviteRealtimeEvent[] = []
    const consumer = new InviteRealtimeEventConsumer(store, (events) => {
      handled.push(...events)
    })
    await consumer.beginSession(accountA)

    // 1) Member A accepts at T1: the producer stamps A's membership row `updatedAt`.
    const accepted: InviteRealtimeEvent = {
      version: 1,
      eventId: '00000000-0000-4000-8000-000000000021',
      streamPosition: cursor1,
      kind: 'shared-vault-membership',
      action: 'accepted',
      sharedVaultUuid: vault,
      memberUserUuid: memberA,
      membershipUuid: membershipA,
      inviteUuid: '40000000-0000-4000-8000-000000000001',
      role: 'write',
      revision: '1789150108395094',
      occurredAt: 1,
    }
    await expect(consumer.consume(accountA, batch([accepted]))).resolves.toMatchObject({
      status: 'applied',
      applied: 1,
    })

    // 2) Member B, who joined before A, is revoked. The removal timestamp is newer than
    //    B's row but older than A's acceptance (T0 < T1) — a different membership row.
    const revokedOlder: InviteRealtimeEvent = {
      version: 1,
      eventId: '00000000-0000-4000-8000-000000000022',
      streamPosition: cursor2,
      kind: 'shared-vault-membership',
      action: 'revoked',
      sharedVaultUuid: vault,
      memberUserUuid: memberB,
      membershipUuid: membershipB,
      revision: '1789150108000000',
      occurredAt: 2,
    }
    await expect(consumer.consume(accountA, batch([revokedOlder], { previousCursor: cursor1 }))).resolves.toEqual({
      status: 'applied',
      ackCursor: cursor2,
      applied: 1,
      duplicates: 0,
      hasMore: false,
    })

    // 3) Member A is revoked later (T2 > T1, and nowhere near T1 + 1): same row, strictly
    //    newer — applied as a delta, never a snapshot.
    const revokedNewer: InviteRealtimeEvent = {
      version: 1,
      eventId: '00000000-0000-4000-8000-000000000023',
      streamPosition: 'cursor-3',
      kind: 'shared-vault-membership',
      action: 'revoked',
      sharedVaultUuid: vault,
      memberUserUuid: memberA,
      membershipUuid: membershipA,
      revision: '1789150108500000',
      occurredAt: 3,
    }
    await expect(consumer.consume(accountA, batch([revokedNewer], { previousCursor: cursor2 }))).resolves.toEqual({
      status: 'applied',
      ackCursor: 'cursor-3',
      applied: 1,
      duplicates: 0,
      hasMore: false,
    })

    // 4) A replay of A's acceptance (older than A's revocation) is fenced out but ACKed past.
    const replayedAcceptance: InviteRealtimeEvent = {
      ...accepted,
      eventId: '00000000-0000-4000-8000-000000000024',
      streamPosition: 'cursor-4',
    }
    await expect(
      consumer.consume(accountA, batch([replayedAcceptance], { previousCursor: 'cursor-3' })),
    ).resolves.toEqual({ status: 'applied', ackCursor: 'cursor-4', applied: 0, duplicates: 1, hasMore: false })

    expect(handled.map((event) => event.eventId)).toEqual([
      '00000000-0000-4000-8000-000000000021',
      '00000000-0000-4000-8000-000000000022',
      '00000000-0000-4000-8000-000000000023',
    ])
    expect(store.values.get(accountA)?.resourceRevisions).toEqual([
      { key: `membership:${membershipB}`, revision: '1789150108000000' },
      { key: `membership:${membershipA}`, revision: '1789150108500000' },
    ])
  })

  it('requires snapshot reconciliation when a resource revision jumps', async () => {
    const store = new MemoryStore()
    store.values.set(accountA, {
      cursor: cursor0,
      seenEventIds: [],
      resourceRevisions: [{ key: 'application:items', revision: '4' }],
    })
    const handler = jest.fn()
    const consumer = new InviteRealtimeEventConsumer(store, handler)
    await consumer.beginSession(accountA)
    const skippedRevision: InviteRealtimeEvent = {
      version: 1,
      eventId: '00000000-0000-4000-8000-000000000014',
      streamPosition: cursor1,
      kind: 'application-state',
      action: 'invalidated',
      resource: 'items',
      revision: '6',
      occurredAt: 6,
    }

    const result = await consumer.consume(accountA, batch([skippedRevision]))
    expect(result).toEqual({
      status: 'reconcile',
      reason: 'revision-gap',
    })
    if (result.status === 'reconcile') {
      expect(getInviteRealtimeRecoveryAction(result)).toBe('snapshot')
      expect(getInviteRealtimeRecoveryAction({ status: 'reconcile', reason: 'handler-failed' })).toBe('retry')
      expect(getInviteRealtimeRecoveryAction({ status: 'reconcile', reason: 'invalid-batch' })).toBe('disconnect')
    }
    expect(handler).not.toHaveBeenCalled()
    expect(store.values.get(accountA)?.cursor).toBe(cursor0)
  })

  it('seeds snapshot revisions at bootstrap and stays on cursor deltas while revisions are healthy', async () => {
    const store = new MemoryStore()
    const handled: InviteRealtimeEvent[] = []
    const consumer = new InviteRealtimeEventConsumer(store, (events) => {
      handled.push(...events)
    })
    await consumer.beginSession(accountA)
    await consumer.resetAfterReconciliation(accountA, cursor0, [{ key: 'application:preferences', revision: '40' }])
    const delta: InviteRealtimeEvent = {
      version: 1,
      eventId: '00000000-0000-4000-8000-000000000015',
      streamPosition: cursor1,
      kind: 'application-state',
      action: 'updated',
      resource: 'preferences',
      revision: '41',
      occurredAt: 41,
    }

    await expect(consumer.consume(accountA, batch([delta]))).resolves.toMatchObject({
      status: 'applied',
      ackCursor: cursor1,
    })
    expect(handled).toEqual([delta])
    expect(store.values.get(accountA)?.resourceRevisions).toEqual([{ key: 'application:preferences', revision: '41' }])
  })
})

import { describe, expect, it, vi } from 'vitest'
import { InviteEventAvailabilityBus } from '../src/inviteEventAvailability.js'
import {
  InviteEventOutboxRecord,
  InviteEventOutboxTransaction,
  InviteEventOutboxDispatcher,
  InviteLifecycleEventProducer,
  SharedVaultMembershipOutboxInput,
} from '../src/inviteEventOutbox.js'
import { InMemoryInviteEventStore, InviteEventStore } from '../src/inviteEventStore.js'
import {
  inviteAccountMember,
  inviteAccountOwner,
  inviteMembershipUuid,
  inviteSharedVault,
  inviteUuid,
} from './fixtures/inviteRealtimeEvents.js'

const secret = '0123456789abcdef0123456789abcdef'

class MemoryOutboxTransaction implements InviteEventOutboxTransaction {
  readonly records = new Map<string, InviteEventOutboxRecord>()

  async insertInviteEventOutboxRecord(record: InviteEventOutboxRecord): Promise<'inserted' | 'duplicate'> {
    const existing = this.records.get(record.recordId)
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(record)) {
        throw new Error('outbox identity conflict')
      }
      return 'duplicate'
    }
    this.records.set(record.recordId, structuredClone(record))
    return 'inserted'
  }
}

class MemoryAvailabilityBus implements InviteEventAvailabilityBus {
  readonly distribution = 'shared' as const
  readonly published: string[] = []
  private readonly listeners = new Map<string, Set<() => void>>()
  failPublish = false

  ready(): boolean {
    return true
  }

  async publishAvailability(userUuid: string): Promise<void> {
    if (this.failPublish) {
      throw new Error('availability unavailable')
    }
    this.published.push(userUuid)
    for (const listener of this.listeners.get(userUuid) ?? []) {
      listener()
    }
  }

  subscribeAvailability(userUuid: string, onAvailable: () => void): () => void {
    const listeners = this.listeners.get(userUuid) ?? new Set()
    listeners.add(onAvailable)
    this.listeners.set(userUuid, listeners)
    return () => listeners.delete(onAvailable)
  }
}

describe('InviteLifecycleEventProducer', () => {
  it('records every invite, subscription, membership, and application lifecycle action transactionally', async () => {
    const transaction = new MemoryOutboxTransaction()
    const producer = new InviteLifecycleEventProducer(() => 1_000)
    let identity = 0
    const eventId = () => `80000000-0000-4000-8000-${(++identity).toString().padStart(12, '0')}`
    const inviteActions = ['created', 'updated', 'accepted', 'declined', 'canceled', 'deleted'] as const

    for (const action of inviteActions) {
      await producer.recordSharedVaultInvite(transaction, {
        eventId: eventId(),
        action,
        inviteUuid,
        sharedVaultUuid: inviteSharedVault,
        affectedUserUuids: [inviteAccountOwner, inviteAccountMember],
      })
      await producer.recordSubscriptionInvite(transaction, {
        eventId: eventId(),
        action,
        inviteUuid,
        affectedUserUuids: [inviteAccountOwner, inviteAccountMember],
      })
    }

    const membershipActions = ['invited', 'accepted', 'joined', 'role-changed', 'left', 'revoked'] as const
    for (const [revision, action] of membershipActions.entries()) {
      await producer.recordSharedVaultMembership(transaction, membershipInput(action, revision + 1, eventId()))
    }
    await producer.recordApplicationState(transaction, {
      eventId: eventId(),
      action: 'updated',
      resource: 'items',
      revision: '1',
      affectedUserUuids: [inviteAccountOwner],
    })
    await producer.recordApplicationState(transaction, {
      eventId: eventId(),
      action: 'invalidated',
      resource: 'files-metadata',
      resourceUuid: inviteSharedVault,
      revision: '1',
      affectedUserUuids: [inviteAccountOwner, inviteAccountMember],
    })

    expect(transaction.records).toHaveLength(20)
    expect([...transaction.records.values()].every((record) => record.recordId === record.event.eventId)).toBe(true)
    expect([...transaction.records.values()].every((record) => !('plaintext' in record.event))).toBe(true)
  })

  it('deduplicates affected accounts and reuses the durable event identity on a transaction retry', async () => {
    const transaction = new MemoryOutboxTransaction()
    const producer = new InviteLifecycleEventProducer(() => 1_000)
    const input = {
      eventId: '80000000-0000-4000-8000-000000000001',
      action: 'created' as const,
      inviteUuid,
      sharedVaultUuid: inviteSharedVault,
      affectedUserUuids: [inviteAccountOwner, inviteAccountMember, inviteAccountOwner],
    }

    await expect(producer.recordSharedVaultInvite(transaction, input)).resolves.toMatchObject({ status: 'inserted' })
    await expect(producer.recordSharedVaultInvite(transaction, input)).resolves.toMatchObject({ status: 'duplicate' })
    expect(transaction.records.get(input.eventId)?.affectedUserUuids).toEqual([inviteAccountOwner, inviteAccountMember])
  })
})

describe('InviteEventOutboxDispatcher', () => {
  it('delivers one transactional event to all online sessions and preserves offline cursor catch-up', async () => {
    const transaction = new MemoryOutboxTransaction()
    const producer = new InviteLifecycleEventProducer(() => 1_000)
    const store = new InMemoryInviteEventStore({ cursorSecret: secret })
    const availability = new MemoryAvailabilityBus()
    const dispatcher = new InviteEventOutboxDispatcher(store, availability)
    const cursorOwner = await store.tail(inviteAccountOwner)
    const cursorMember = await store.tail(inviteAccountMember)
    const ownerSessionOne = vi.fn()
    const ownerSessionTwo = vi.fn()
    availability.subscribeAvailability(inviteAccountOwner, ownerSessionOne)
    availability.subscribeAvailability(inviteAccountOwner, ownerSessionTwo)

    const produced = await producer.recordSharedVaultInvite(transaction, {
      eventId: '80000000-0000-4000-8000-000000000001',
      action: 'created',
      inviteUuid,
      sharedVaultUuid: inviteSharedVault,
      affectedUserUuids: [inviteAccountOwner, inviteAccountMember],
    })
    await expect(dispatcher.dispatch(produced.record)).resolves.toEqual({
      affectedUsers: 2,
      appended: 2,
      duplicates: 0,
    })

    expect(ownerSessionOne).toHaveBeenCalledTimes(1)
    expect(ownerSessionTwo).toHaveBeenCalledTimes(1)
    expect((await store.readAfter(inviteAccountOwner, cursorOwner)).events).toHaveLength(1)
    expect((await store.readAfter(inviteAccountMember, cursorMember)).events).toHaveLength(1)

    await expect(dispatcher.dispatch(produced.record)).resolves.toEqual({
      affectedUsers: 2,
      appended: 0,
      duplicates: 2,
    })
    expect((await store.readAfter(inviteAccountOwner, cursorOwner)).events).toHaveLength(1)
    expect((await store.readAfter(inviteAccountMember, cursorMember)).events).toHaveLength(1)
  })

  it('safely retries partial fanout and publish failures with the same event identity', async () => {
    const inner = new InMemoryInviteEventStore({ cursorSecret: secret })
    let failMemberOnce = true
    const store: InviteEventStore = {
      distribution: 'shared',
      ready: () => true,
      append: async (userUuid, event) => {
        if (userUuid === inviteAccountMember && failMemberOnce) {
          failMemberOnce = false
          throw new Error('member stream temporarily unavailable')
        }
        return inner.append(userUuid, event)
      },
      tail: (userUuid) => inner.tail(userUuid),
      readAfter: (userUuid, cursor, limit) => inner.readAfter(userUuid, cursor, limit),
    }
    const availability = new MemoryAvailabilityBus()
    const dispatcher = new InviteEventOutboxDispatcher(store, availability)
    const transaction = new MemoryOutboxTransaction()
    const produced = await new InviteLifecycleEventProducer(() => 1_000).recordSharedVaultInvite(transaction, {
      eventId: '80000000-0000-4000-8000-000000000001',
      action: 'accepted',
      inviteUuid,
      sharedVaultUuid: inviteSharedVault,
      affectedUserUuids: [inviteAccountOwner, inviteAccountMember],
    })
    const cursorOwner = await store.tail(inviteAccountOwner)
    const cursorMember = await store.tail(inviteAccountMember)

    await expect(dispatcher.dispatch(produced.record)).rejects.toThrow('temporarily unavailable')
    expect(availability.published).toEqual([])
    await expect(dispatcher.dispatch(produced.record)).resolves.toEqual({
      affectedUsers: 2,
      appended: 1,
      duplicates: 1,
    })
    expect(availability.published).toEqual([inviteAccountOwner, inviteAccountMember])
    expect((await store.readAfter(inviteAccountOwner, cursorOwner)).events).toHaveLength(1)
    expect((await store.readAfter(inviteAccountMember, cursorMember)).events).toHaveLength(1)

    availability.failPublish = true
    await expect(dispatcher.dispatch(produced.record)).rejects.toThrow('availability unavailable')
    availability.failPublish = false
    await expect(dispatcher.dispatch(produced.record)).resolves.toMatchObject({ appended: 0, duplicates: 2 })
  })
})

function membershipInput(
  action: SharedVaultMembershipOutboxInput['action'],
  revision: number,
  eventId: string,
): SharedVaultMembershipOutboxInput {
  const common = {
    eventId,
    action,
    sharedVaultUuid: inviteSharedVault,
    memberUserUuid: inviteAccountMember,
    revision: String(revision),
    affectedUserUuids: [inviteAccountOwner, inviteAccountMember],
  }
  switch (action) {
    case 'invited':
      return { ...common, inviteUuid, role: 'write' }
    case 'accepted':
      return { ...common, inviteUuid, membershipUuid: inviteMembershipUuid, role: 'write' }
    case 'joined':
    case 'role-changed':
      return { ...common, membershipUuid: inviteMembershipUuid, role: 'admin' }
    case 'left':
    case 'revoked':
      return { ...common, membershipUuid: inviteMembershipUuid }
  }
}

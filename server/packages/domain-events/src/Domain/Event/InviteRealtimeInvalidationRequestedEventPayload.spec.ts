import {
  INVITE_REALTIME_INVALIDATION_VERSION,
  InviteRealtimeInvalidation,
  InviteRealtimeMembershipAction,
  isInviteRealtimeInvalidation,
  isInviteRealtimeInvalidationRequestedEventPayload,
} from './InviteRealtimeInvalidationRequestedEventPayload'

// These fixtures are the gateway's (`websocket-gateway/test/inviteEventStore.test.ts`,
// "invite event validation"). The two validators must agree exactly: a payload the
// gateway rejects is never acknowledged on SQS and is redelivered forever.
const accountA = '00000000-0000-4000-8000-000000000001'
const accountB = '00000000-0000-4000-8000-000000000002'
const sharedVaultUuid = '20000000-0000-4000-8000-000000000001'
const inviteUuid = '10000000-0000-4000-8000-000000000001'
const membershipUuid = '30000000-0000-4000-8000-000000000001'

type SharedVaultInviteEvent = Extract<InviteRealtimeInvalidation, { kind: 'shared-vault-invite' }>

const inviteEvent = (index: number, overrides: Partial<SharedVaultInviteEvent> = {}): InviteRealtimeInvalidation => ({
  version: 1,
  eventId: `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
  kind: 'shared-vault-invite',
  action: 'created',
  inviteUuid,
  sharedVaultUuid,
  occurredAt: index + 1,
  ...overrides,
})

const membershipEvent = (action: InviteRealtimeMembershipAction, index: number): InviteRealtimeInvalidation => {
  const common = {
    version: 1 as const,
    eventId: `50000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
    kind: 'shared-vault-membership' as const,
    action,
    sharedVaultUuid,
    memberUserUuid: accountB,
    revision: String(index),
    occurredAt: index,
  }
  switch (action) {
    case 'invited':
      return { ...common, inviteUuid, role: 'write' }
    case 'accepted':
      return { ...common, membershipUuid, inviteUuid, role: 'write' }
    case 'joined':
    case 'role-changed':
      return { ...common, membershipUuid, role: 'write' }
    case 'left':
    case 'revoked':
      return { ...common, membershipUuid }
  }
}

const subscriptionEvent = {
  version: 1,
  eventId: '70000000-0000-4000-8000-000000000001',
  kind: 'subscription-invite',
  action: 'updated',
  inviteUuid,
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

const payloadFor = (event: InviteRealtimeInvalidation, affectedUserUuids: string[] = [accountA, accountB]) => ({
  version: 1,
  recordId: event.eventId,
  affectedUserUuids,
  event,
})

describe('isInviteRealtimeInvalidation', () => {
  it('accepts every canonical event family', () => {
    expect(INVITE_REALTIME_INVALIDATION_VERSION).toBe(1)
    expect(isInviteRealtimeInvalidation(inviteEvent(1))).toBe(true)
    expect(isInviteRealtimeInvalidation(subscriptionEvent)).toBe(true)
    expect(isInviteRealtimeInvalidation(applicationEvent)).toBe(true)
    expect(
      isInviteRealtimeInvalidation({
        ...applicationEvent,
        action: 'invalidated',
        resource: 'subscriptions',
        resourceUuid: accountA,
      }),
    ).toBe(true)
    for (const action of ['created', 'updated', 'accepted', 'declined', 'canceled', 'deleted'] as const) {
      expect(isInviteRealtimeInvalidation(inviteEvent(1, { action }))).toBe(true)
      expect(isInviteRealtimeInvalidation({ ...subscriptionEvent, action })).toBe(true)
    }
    const membershipActions: InviteRealtimeMembershipAction[] = [
      'invited',
      'accepted',
      'joined',
      'left',
      'revoked',
      'role-changed',
    ]
    membershipActions.forEach((action, index) => {
      expect(isInviteRealtimeInvalidation(membershipEvent(action, index + 1))).toBe(true)
    })
  })

  it('accepts the membership revision shape the syncing-server emits (C12 fixture)', () => {
    const accepted = membershipEvent('accepted', 7)
    expect(isInviteRealtimeInvalidation({ ...accepted, revision: '1789150108395094', membershipUuid })).toBe(true)
    expect(isInviteRealtimeInvalidation({ ...accepted, revision: '9'.repeat(32) })).toBe(true)
    expect(isInviteRealtimeInvalidation({ ...accepted, revision: '9'.repeat(33) })).toBe(false)
  })

  it('rejects malformed base and invite-family fields without accepting extra payload data', () => {
    const invalid: unknown[] = [
      null,
      undefined,
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
      expect(isInviteRealtimeInvalidation(event)).toBe(false)
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
      { ...accepted, revision: '' },
      { ...accepted, revision: '01' },
      { ...accepted, revision: '1.5' },
      { ...accepted, revision: 'a'.repeat(128) },
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
      expect(isInviteRealtimeInvalidation(event)).toBe(false)
    }
  })
})

describe('isInviteRealtimeInvalidationRequestedEventPayload', () => {
  it('accepts a canonical payload for every family', () => {
    expect(isInviteRealtimeInvalidationRequestedEventPayload(payloadFor(inviteEvent(1)))).toBe(true)
    expect(isInviteRealtimeInvalidationRequestedEventPayload(payloadFor(subscriptionEvent))).toBe(true)
    expect(isInviteRealtimeInvalidationRequestedEventPayload(payloadFor(membershipEvent('revoked', 2)))).toBe(true)
    expect(isInviteRealtimeInvalidationRequestedEventPayload(payloadFor(applicationEvent, [accountA]))).toBe(true)
  })

  it('rejects malformed envelopes, fanout lists and identity mismatches', () => {
    const canonical = payloadFor(inviteEvent(1))
    const tooManyUsers = Array.from(
      { length: 1_001 },
      (_, index) => `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
    )
    const invalid: unknown[] = [
      null,
      [],
      'payload',
      { ...canonical, plaintext: 'must-not-pass' },
      { ...canonical, version: 2 },
      { ...canonical, recordId: 'invalid' },
      { ...canonical, recordId: inviteEvent(2).eventId },
      { ...canonical, affectedUserUuids: accountA },
      { ...canonical, affectedUserUuids: [] },
      { ...canonical, affectedUserUuids: tooManyUsers },
      { ...canonical, affectedUserUuids: [accountA, 'not-a-user'] },
      { ...canonical, affectedUserUuids: [accountA, accountA] },
      { ...canonical, event: { ...inviteEvent(1), plaintext: 'must-not-pass' } },
      { ...canonical, event: undefined },
    ]

    for (const payload of invalid) {
      expect(isInviteRealtimeInvalidationRequestedEventPayload(payload)).toBe(false)
    }
    expect(
      isInviteRealtimeInvalidationRequestedEventPayload(payloadFor(inviteEvent(1), tooManyUsers.slice(0, 1_000))),
    ).toBe(true)
  })
})

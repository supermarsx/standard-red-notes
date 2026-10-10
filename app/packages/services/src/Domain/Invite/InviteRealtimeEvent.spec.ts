import {
  getInviteRealtimeRevisionIdentity,
  InviteRealtimeEvent,
  isInviteRealtimeBatch,
  isInviteRealtimeEvent,
  SharedVaultMembershipRealtimeAction,
} from './InviteRealtimeEvent'

const base = {
  version: 1 as const,
  eventId: '00000000-0000-4000-8000-000000000001',
  streamPosition: 'cursor-1',
  occurredAt: 1,
}
const sharedVaultUuid = '10000000-0000-4000-8000-000000000001'
const memberUserUuid = '20000000-0000-4000-8000-000000000001'
const membershipUuid = '30000000-0000-4000-8000-000000000001'
const inviteUuid = '40000000-0000-4000-8000-000000000001'

function membershipEvent(action: SharedVaultMembershipRealtimeAction): InviteRealtimeEvent {
  const common = {
    ...base,
    kind: 'shared-vault-membership' as const,
    action,
    sharedVaultUuid,
    memberUserUuid,
    revision: '1',
  }
  switch (action) {
    case 'invited':
      return { ...common, inviteUuid, role: 'write' }
    case 'accepted':
      return { ...common, membershipUuid, inviteUuid, role: 'write' }
    case 'joined':
      return { ...common, membershipUuid, role: 'write' }
    case 'left':
    case 'revoked':
      return { ...common, membershipUuid }
    case 'role-changed':
      return { ...common, membershipUuid, role: 'read' }
  }
}

describe('InviteRealtimeEvent account-state contract', () => {
  it.each<SharedVaultMembershipRealtimeAction>(['invited', 'accepted', 'joined', 'left', 'revoked', 'role-changed'])(
    'accepts the strict metadata-only %s membership shape',
    (action) => {
      expect(isInviteRealtimeEvent(membershipEvent(action))).toBe(true)
    },
  )

  /**
   * `role-changed` was rejected while nothing produced it. The syncing-server's
   * `UpdateSharedVaultUserPermission` now does, and this event is the ONLY thing that
   * refreshes `VaultUserCache` -- which `IsReadonlyVaultMember` reads and nothing else
   * updates. Rejecting it would leave a demoted member's editor writable, and an action a
   * client does not know makes it drop the connection.
   *
   * It is admitted on exactly one shape: an existing membership row, the new role, no
   * invite.
   */
  it('admits role-changed only with a membership row and a role, and never with an invite', () => {
    const roleChanged = membershipEvent('role-changed') as Record<string, unknown>

    expect(isInviteRealtimeEvent(roleChanged)).toBe(true)
    expect(roleChanged.role).toEqual('read')

    const withoutRole = { ...roleChanged }
    delete withoutRole.role
    expect(isInviteRealtimeEvent(withoutRole)).toBe(false)

    const withoutMembership = { ...roleChanged }
    delete withoutMembership.membershipUuid
    expect(isInviteRealtimeEvent(withoutMembership)).toBe(false)

    expect(isInviteRealtimeEvent({ ...roleChanged, inviteUuid })).toBe(false)
    expect(isInviteRealtimeEvent({ ...roleChanged, role: 'owner' })).toBe(false)
    // Widening this action did not widen the others: left/revoked still carry no role.
    expect(isInviteRealtimeEvent({ ...membershipEvent('left'), role: 'read' })).toBe(false)
  })

  it('fences a role change per membership row, so the member learns of it', () => {
    expect(getInviteRealtimeRevisionIdentity(membershipEvent('role-changed'))).toEqual({
      key: `membership:${membershipUuid}`,
      revision: '1',
      ordering: 'timestamp',
    })
  })

  it('fences membership revisions per membership row as strictly-increasing timestamps', () => {
    expect(getInviteRealtimeRevisionIdentity(membershipEvent('revoked'))).toEqual({
      key: `membership:${membershipUuid}`,
      revision: '1',
      ordering: 'timestamp',
    })
    // An invitation has no membership row yet; the vault is the only stable key.
    expect(getInviteRealtimeRevisionIdentity(membershipEvent('invited'))).toEqual({
      key: `membership:${sharedVaultUuid}`,
      revision: '1',
      ordering: 'timestamp',
    })
    expect(
      getInviteRealtimeRevisionIdentity({
        ...base,
        kind: 'application-state',
        action: 'updated',
        resource: 'items',
        revision: '9',
      }),
    ).toEqual({ key: 'application:items', revision: '9', ordering: 'counter' })
    expect(
      getInviteRealtimeRevisionIdentity({
        ...base,
        kind: 'subscription-invite',
        action: 'created',
        inviteUuid,
      }),
    ).toBeUndefined()
  })

  it('accepts application-state signals and rejects binary bodies or non-canonical revisions', () => {
    const event: InviteRealtimeEvent = {
      ...base,
      kind: 'application-state',
      action: 'updated',
      resource: 'files-metadata',
      resourceUuid: '50000000-0000-4000-8000-000000000001',
      revision: '9',
    }

    expect(isInviteRealtimeEvent(event)).toBe(true)
    expect(isInviteRealtimeEvent({ ...event, bytes: 'base64-file-body' })).toBe(false)
    expect(isInviteRealtimeEvent({ ...event, revision: '09' })).toBe(false)
    expect(isInviteRealtimeEvent({ ...event, revision: '0' })).toBe(false)
  })

  it('rejects structurally incomplete membership changes and empty continuation batches', () => {
    const joined = membershipEvent('joined')
    expect(isInviteRealtimeEvent({ ...joined, role: undefined })).toBe(false)
    expect(isInviteRealtimeEvent({ ...membershipEvent('revoked'), role: 'read' })).toBe(false)
    expect(isInviteRealtimeEvent({ ...membershipEvent('joined'), memberEmail: 'secret@example.com' })).toBe(false)
    expect(
      isInviteRealtimeBatch({ previousCursor: 'cursor-1', nextCursor: 'cursor-1', events: [], hasMore: true }),
    ).toBe(false)
  })
})

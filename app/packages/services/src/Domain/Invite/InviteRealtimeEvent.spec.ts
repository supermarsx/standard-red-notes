import {
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
    case 'role-changed':
      return { ...common, membershipUuid, role: 'write' }
    case 'left':
    case 'revoked':
      return { ...common, membershipUuid }
  }
}

describe('InviteRealtimeEvent account-state contract', () => {
  it.each<SharedVaultMembershipRealtimeAction>(['invited', 'accepted', 'joined', 'left', 'revoked', 'role-changed'])(
    'accepts the strict metadata-only %s membership shape',
    (action) => {
      expect(isInviteRealtimeEvent(membershipEvent(action))).toBe(true)
    },
  )

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
    const roleChange = membershipEvent('role-changed')
    expect(isInviteRealtimeEvent({ ...roleChange, role: undefined })).toBe(false)
    expect(isInviteRealtimeEvent({ ...membershipEvent('revoked'), role: 'read' })).toBe(false)
    expect(isInviteRealtimeEvent({ ...membershipEvent('joined'), memberEmail: 'secret@example.com' })).toBe(false)
    expect(
      isInviteRealtimeBatch({ previousCursor: 'cursor-1', nextCursor: 'cursor-1', events: [], hasMore: true }),
    ).toBe(false)
  })
})

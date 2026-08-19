import { InviteEventAction, SharedVaultMembershipEventAction, StoredInviteEvent } from '../../src/inviteEventStore.js'

export const inviteAccountOwner = '00000000-0000-4000-8000-000000000001'
export const inviteAccountMember = '00000000-0000-4000-8000-000000000002'
export const inviteSharedVault = '10000000-0000-4000-8000-000000000001'
export const inviteUuid = '20000000-0000-4000-8000-000000000001'
export const inviteMembershipUuid = '30000000-0000-4000-8000-000000000001'

export function inviteRealtimeProtocolEvents(): StoredInviteEvent[] {
  let index = 0
  const envelope = () => {
    index += 1
    return {
      version: 1 as const,
      eventId: `70000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
      streamPosition: `cursor-${index}`,
      occurredAt: index,
    }
  }
  const inviteActions: InviteEventAction[] = ['created', 'updated', 'accepted', 'declined', 'canceled', 'deleted']
  const membershipActions: SharedVaultMembershipEventAction[] = [
    'invited',
    'accepted',
    'joined',
    'role-changed',
    'left',
    'revoked',
  ]

  return [
    ...inviteActions.map((action): StoredInviteEvent => ({
      ...envelope(),
      kind: 'shared-vault-invite',
      action,
      inviteUuid,
      sharedVaultUuid: inviteSharedVault,
    })),
    ...inviteActions.map((action): StoredInviteEvent => ({
      ...envelope(),
      kind: 'subscription-invite',
      action,
      inviteUuid,
    })),
    ...membershipActions.map((action, revision): StoredInviteEvent => {
      const common = {
        ...envelope(),
        kind: 'shared-vault-membership' as const,
        action,
        sharedVaultUuid: inviteSharedVault,
        memberUserUuid: inviteAccountMember,
        revision: String(revision + 1),
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
    }),
    {
      ...envelope(),
      kind: 'application-state',
      action: 'updated',
      resource: 'items',
      revision: '1',
    },
    {
      ...envelope(),
      kind: 'application-state',
      action: 'invalidated',
      resource: 'files-metadata',
      resourceUuid: inviteSharedVault,
      revision: '1',
    },
  ]
}

import { SharedVaultUserPermission, Timestamps, UniqueEntityId, Uuid } from '@standardnotes/domain-core'

import { SharedVaultInvite } from '../../Domain/SharedVault/User/Invite/SharedVaultInvite'

import { SharedVaultInviteHttpMapper } from './SharedVaultInviteHttpMapper'

describe('SharedVaultInviteHttpMapper', () => {
  const inviteUuid = '00000000-0000-0000-0000-000000000001'
  const sharedVaultUuid = '00000000-0000-0000-0000-000000000002'
  const userUuid = '00000000-0000-0000-0000-000000000003'
  const senderUuid = '00000000-0000-0000-0000-000000000004'

  const createMapper = () => new SharedVaultInviteHttpMapper()

  const createInvite = (permission = SharedVaultUserPermission.PERMISSIONS.Write) =>
    SharedVaultInvite.create(
      {
        sharedVaultUuid: Uuid.create(sharedVaultUuid).getValue(),
        userUuid: Uuid.create(userUuid).getValue(),
        senderUuid: Uuid.create(senderUuid).getValue(),
        encryptedMessage: 'encrypted-message',
        permission: SharedVaultUserPermission.create(permission).getValue(),
        timestamps: Timestamps.create(123, 456).getValue(),
      },
      new UniqueEntityId(inviteUuid),
    ).getValue()

  it('maps an invite onto its http representation', () => {
    expect(createMapper().toProjection(createInvite())).toEqual({
      uuid: inviteUuid,
      shared_vault_uuid: sharedVaultUuid,
      user_uuid: userUuid,
      sender_uuid: senderUuid,
      encrypted_message: 'encrypted-message',
      permission: SharedVaultUserPermission.PERMISSIONS.Write,
      created_at_timestamp: 123,
      updated_at_timestamp: 456,
    })
  })

  it('carries the granted permission level through unchanged', () => {
    const projection = createMapper().toProjection(createInvite(SharedVaultUserPermission.PERMISSIONS.Read))

    expect(projection.permission).toEqual(SharedVaultUserPermission.PERMISSIONS.Read)
  })

  it('refuses to map an http representation back to the domain', () => {
    expect(() => createMapper().toDomain({} as never)).toThrow(
      'Mapping from http representation to domain is not implemented.',
    )
  })
})

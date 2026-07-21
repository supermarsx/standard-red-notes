import { SharedVaultUserPermission, Timestamps, UniqueEntityId, Uuid } from '@standardnotes/domain-core'

import { SharedVaultInvite } from '../../Domain/SharedVault/User/Invite/SharedVaultInvite'
import { TypeORMSharedVaultInvite } from '../../Infra/TypeORM/TypeORMSharedVaultInvite'

import { SharedVaultInvitePersistenceMapper } from './SharedVaultInvitePersistenceMapper'

describe('SharedVaultInvitePersistenceMapper', () => {
  const inviteUuid = '00000000-0000-0000-0000-000000000001'
  const sharedVaultUuid = '00000000-0000-0000-0000-000000000002'
  const userUuid = '00000000-0000-0000-0000-000000000003'
  const senderUuid = '00000000-0000-0000-0000-000000000004'

  const createMapper = () => new SharedVaultInvitePersistenceMapper()

  const createProjection = (overrides: Partial<TypeORMSharedVaultInvite> = {}): TypeORMSharedVaultInvite => {
    const typeorm = new TypeORMSharedVaultInvite()
    typeorm.uuid = inviteUuid
    typeorm.sharedVaultUuid = sharedVaultUuid
    typeorm.userUuid = userUuid
    typeorm.senderUuid = senderUuid
    typeorm.permission = SharedVaultUserPermission.PERMISSIONS.Write
    typeorm.encryptedMessage = 'encrypted-message'
    typeorm.createdAtTimestamp = 123
    typeorm.updatedAtTimestamp = 456

    return Object.assign(typeorm, overrides)
  }

  const createDomain = () =>
    SharedVaultInvite.create(
      {
        sharedVaultUuid: Uuid.create(sharedVaultUuid).getValue(),
        userUuid: Uuid.create(userUuid).getValue(),
        senderUuid: Uuid.create(senderUuid).getValue(),
        encryptedMessage: 'encrypted-message',
        permission: SharedVaultUserPermission.create(SharedVaultUserPermission.PERMISSIONS.Write).getValue(),
        timestamps: Timestamps.create(123, 456).getValue(),
      },
      new UniqueEntityId(inviteUuid),
    ).getValue()

  it('rebuilds the invite from its persisted row', () => {
    const invite = createMapper().toDomain(createProjection())

    expect(invite.id.toString()).toEqual(inviteUuid)
    expect(invite.props.sharedVaultUuid.value).toEqual(sharedVaultUuid)
    expect(invite.props.userUuid.value).toEqual(userUuid)
    expect(invite.props.senderUuid.value).toEqual(senderUuid)
    expect(invite.props.permission.value).toEqual(SharedVaultUserPermission.PERMISSIONS.Write)
    expect(invite.props.encryptedMessage).toEqual('encrypted-message')
    expect(invite.props.timestamps.createdAt).toEqual(123)
    expect(invite.props.timestamps.updatedAt).toEqual(456)
  })

  it('rejects a row with a malformed invitee uuid', () => {
    expect(() => createMapper().toDomain(createProjection({ userUuid: 'not-a-uuid' }))).toThrow(
      /^Failed to create shared vault invite from projection:/,
    )
  })

  it('rejects a row with a malformed sender uuid', () => {
    expect(() => createMapper().toDomain(createProjection({ senderUuid: 'not-a-uuid' }))).toThrow(
      /^Failed to create shared vault invite from projection:/,
    )
  })

  it('rejects a row with a malformed shared vault uuid', () => {
    expect(() => createMapper().toDomain(createProjection({ sharedVaultUuid: 'not-a-uuid' }))).toThrow(
      /^Failed to create shared vault invite from projection:/,
    )
  })

  it('rejects a row whose timestamps are not numbers', () => {
    expect(() => createMapper().toDomain(createProjection({ updatedAtTimestamp: '456' as unknown as number }))).toThrow(
      /^Failed to create shared vault invite from projection:/,
    )
  })

  it('rejects a row granting an unknown permission', () => {
    expect(() => createMapper().toDomain(createProjection({ permission: 'god-mode' }))).toThrow(
      /^Failed to create shared vault invite from projection:/,
    )
  })

  it('rejects a row with an empty encrypted message', () => {
    expect(() => createMapper().toDomain(createProjection({ encryptedMessage: '' }))).toThrow(
      /^Failed to create shared vault invite from projection:/,
    )
  })

  it('maps an invite onto its persisted row', () => {
    const projection = createMapper().toProjection(createDomain())

    expect(projection).toBeInstanceOf(TypeORMSharedVaultInvite)
    expect(projection.uuid).toEqual(inviteUuid)
    expect(projection.sharedVaultUuid).toEqual(sharedVaultUuid)
    expect(projection.userUuid).toEqual(userUuid)
    expect(projection.senderUuid).toEqual(senderUuid)
    expect(projection.permission).toEqual(SharedVaultUserPermission.PERMISSIONS.Write)
    expect(projection.encryptedMessage).toEqual('encrypted-message')
    expect(projection.createdAtTimestamp).toEqual(123)
    expect(projection.updatedAtTimestamp).toEqual(456)
  })

  it('round trips an invite without altering it', () => {
    const mapper = createMapper()

    expect(mapper.toProjection(mapper.toDomain(createProjection()))).toEqual(createProjection())
  })
})

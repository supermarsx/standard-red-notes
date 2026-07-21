import {
  SharedVaultUser,
  SharedVaultUserPermission,
  Timestamps,
  UniqueEntityId,
  Uuid,
} from '@standardnotes/domain-core'

import { SharedVaultUserHttpMapper } from './SharedVaultUserHttpMapper'

describe('SharedVaultUserHttpMapper', () => {
  const sharedVaultUserUuid = '00000000-0000-0000-0000-000000000001'
  const sharedVaultUuid = '00000000-0000-0000-0000-000000000002'
  const userUuid = '00000000-0000-0000-0000-000000000003'

  const createMapper = () => new SharedVaultUserHttpMapper()

  const createSharedVaultUser = (isDesignatedSurvivor = false) =>
    SharedVaultUser.create(
      {
        sharedVaultUuid: Uuid.create(sharedVaultUuid).getValue(),
        userUuid: Uuid.create(userUuid).getValue(),
        permission: SharedVaultUserPermission.create(SharedVaultUserPermission.PERMISSIONS.Write).getValue(),
        isDesignatedSurvivor,
        timestamps: Timestamps.create(123, 456).getValue(),
      },
      new UniqueEntityId(sharedVaultUserUuid),
    ).getValue()

  it('maps a shared vault user onto its http representation', () => {
    expect(createMapper().toProjection(createSharedVaultUser())).toEqual({
      uuid: sharedVaultUserUuid,
      user_uuid: userUuid,
      permission: SharedVaultUserPermission.PERMISSIONS.Write,
      shared_vault_uuid: sharedVaultUuid,
      is_designated_survivor: false,
      created_at_timestamp: 123,
      updated_at_timestamp: 456,
    })
  })

  it('reports a designated survivor as such', () => {
    expect(createMapper().toProjection(createSharedVaultUser(true)).is_designated_survivor).toBe(true)
  })

  it('refuses to map an http representation back to the domain', () => {
    expect(() => createMapper().toDomain({} as never)).toThrow(
      'Mapping from http representation to domain is not implemented.',
    )
  })
})

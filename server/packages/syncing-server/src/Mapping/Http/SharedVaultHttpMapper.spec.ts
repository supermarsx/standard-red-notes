import { Timestamps, UniqueEntityId, Uuid } from '@standardnotes/domain-core'

import { SharedVault } from '../../Domain/SharedVault/SharedVault'

import { SharedVaultHttpMapper } from './SharedVaultHttpMapper'

describe('SharedVaultHttpMapper', () => {
  const sharedVaultUuid = '00000000-0000-0000-0000-000000000001'
  const userUuid = '00000000-0000-0000-0000-000000000002'

  const createMapper = () => new SharedVaultHttpMapper()

  const createSharedVault = (fileUploadBytesUsed = 1024) =>
    SharedVault.create(
      {
        userUuid: Uuid.create(userUuid).getValue(),
        fileUploadBytesUsed,
        timestamps: Timestamps.create(123, 456).getValue(),
      },
      new UniqueEntityId(sharedVaultUuid),
    ).getValue()

  it('maps a shared vault onto its http representation', () => {
    expect(createMapper().toProjection(createSharedVault())).toEqual({
      uuid: sharedVaultUuid,
      user_uuid: userUuid,
      file_upload_bytes_used: 1024,
      created_at_timestamp: 123,
      updated_at_timestamp: 456,
    })
  })

  it('reports a zero byte usage rather than omitting it', () => {
    const projection = createMapper().toProjection(createSharedVault(0))

    expect(projection.file_upload_bytes_used).toEqual(0)
  })

  it('refuses to map an http representation back to the domain', () => {
    expect(() => createMapper().toDomain({} as never)).toThrow(
      'Mapping from http representation to domain is not implemented.',
    )
  })
})

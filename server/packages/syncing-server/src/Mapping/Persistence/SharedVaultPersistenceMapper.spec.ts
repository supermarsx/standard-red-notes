import { Timestamps, UniqueEntityId, Uuid } from '@standardnotes/domain-core'

import { SharedVault } from '../../Domain/SharedVault/SharedVault'
import { TypeORMSharedVault } from '../../Infra/TypeORM/TypeORMSharedVault'

import { SharedVaultPersistenceMapper } from './SharedVaultPersistenceMapper'

describe('SharedVaultPersistenceMapper', () => {
  const sharedVaultUuid = '00000000-0000-0000-0000-000000000001'
  const userUuid = '00000000-0000-0000-0000-000000000002'

  const createMapper = () => new SharedVaultPersistenceMapper()

  const createProjection = (overrides: Partial<TypeORMSharedVault> = {}): TypeORMSharedVault => {
    const typeorm = new TypeORMSharedVault()
    typeorm.uuid = sharedVaultUuid
    typeorm.userUuid = userUuid
    typeorm.fileUploadBytesUsed = 2048
    typeorm.createdAtTimestamp = 123
    typeorm.updatedAtTimestamp = 456

    return Object.assign(typeorm, overrides)
  }

  const createDomain = () =>
    SharedVault.create(
      {
        userUuid: Uuid.create(userUuid).getValue(),
        fileUploadBytesUsed: 2048,
        timestamps: Timestamps.create(123, 456).getValue(),
      },
      new UniqueEntityId(sharedVaultUuid),
    ).getValue()

  it('rebuilds the shared vault from its persisted row', () => {
    const sharedVault = createMapper().toDomain(createProjection())

    expect(sharedVault.id.toString()).toEqual(sharedVaultUuid)
    expect(sharedVault.props.userUuid.value).toEqual(userUuid)
    expect(sharedVault.props.fileUploadBytesUsed).toEqual(2048)
    expect(sharedVault.props.timestamps.createdAt).toEqual(123)
    expect(sharedVault.props.timestamps.updatedAt).toEqual(456)
  })

  it('rejects a row with a malformed owner uuid', () => {
    expect(() => createMapper().toDomain(createProjection({ userUuid: 'not-a-uuid' }))).toThrow(
      /^Failed to create shared vault from projection:/,
    )
  })

  it('rejects a row whose timestamps are not numbers', () => {
    expect(() => createMapper().toDomain(createProjection({ createdAtTimestamp: '123' as unknown as number }))).toThrow(
      /^Failed to create shared vault from projection:/,
    )
  })

  it('maps a shared vault onto its persisted row', () => {
    const projection = createMapper().toProjection(createDomain())

    expect(projection).toBeInstanceOf(TypeORMSharedVault)
    expect(projection.uuid).toEqual(sharedVaultUuid)
    expect(projection.userUuid).toEqual(userUuid)
    expect(projection.fileUploadBytesUsed).toEqual(2048)
    expect(projection.createdAtTimestamp).toEqual(123)
    expect(projection.updatedAtTimestamp).toEqual(456)
  })

  it('round trips a shared vault without altering it', () => {
    const mapper = createMapper()

    expect(mapper.toProjection(mapper.toDomain(createProjection()))).toEqual(createProjection())
  })
})

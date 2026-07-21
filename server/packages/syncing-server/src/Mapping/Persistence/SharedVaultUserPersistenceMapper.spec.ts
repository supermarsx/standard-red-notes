import {
  SharedVaultUser,
  SharedVaultUserPermission,
  Timestamps,
  UniqueEntityId,
  Uuid,
} from '@standardnotes/domain-core'

import { TypeORMSharedVaultUser } from '../../Infra/TypeORM/TypeORMSharedVaultUser'

import { SharedVaultUserPersistenceMapper } from './SharedVaultUserPersistenceMapper'

describe('SharedVaultUserPersistenceMapper', () => {
  const sharedVaultUserUuid = '00000000-0000-0000-0000-000000000001'
  const sharedVaultUuid = '00000000-0000-0000-0000-000000000002'
  const userUuid = '00000000-0000-0000-0000-000000000003'

  const createMapper = () => new SharedVaultUserPersistenceMapper()

  const createProjection = (overrides: Partial<TypeORMSharedVaultUser> = {}): TypeORMSharedVaultUser => {
    const typeorm = new TypeORMSharedVaultUser()
    typeorm.uuid = sharedVaultUserUuid
    typeorm.sharedVaultUuid = sharedVaultUuid
    typeorm.userUuid = userUuid
    typeorm.permission = SharedVaultUserPermission.PERMISSIONS.Write
    typeorm.isDesignatedSurvivor = false
    typeorm.createdAtTimestamp = 123
    typeorm.updatedAtTimestamp = 456

    return Object.assign(typeorm, overrides)
  }

  const createDomain = (isDesignatedSurvivor = false) =>
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

  it('rebuilds the shared vault user from its persisted row', () => {
    const sharedVaultUser = createMapper().toDomain(createProjection())

    expect(sharedVaultUser.id.toString()).toEqual(sharedVaultUserUuid)
    expect(sharedVaultUser.props.sharedVaultUuid.value).toEqual(sharedVaultUuid)
    expect(sharedVaultUser.props.userUuid.value).toEqual(userUuid)
    expect(sharedVaultUser.props.permission.value).toEqual(SharedVaultUserPermission.PERMISSIONS.Write)
    expect(sharedVaultUser.props.isDesignatedSurvivor).toBe(false)
    expect(sharedVaultUser.props.timestamps.createdAt).toEqual(123)
  })

  it('rejects a row with a malformed member uuid', () => {
    expect(() => createMapper().toDomain(createProjection({ userUuid: 'not-a-uuid' }))).toThrow(
      /^Failed to create shared vault user from projection:/,
    )
  })

  it('rejects a row with a malformed shared vault uuid', () => {
    expect(() => createMapper().toDomain(createProjection({ sharedVaultUuid: 'not-a-uuid' }))).toThrow(
      /^Failed to create shared vault user from projection:/,
    )
  })

  it('rejects a row whose timestamps are not numbers', () => {
    expect(() => createMapper().toDomain(createProjection({ createdAtTimestamp: '123' as unknown as number }))).toThrow(
      /^Failed to create shared vault user from projection:/,
    )
  })

  it('rejects a row granting an unknown permission', () => {
    expect(() => createMapper().toDomain(createProjection({ permission: 'god-mode' }))).toThrow(
      /^Failed to create shared vault user from projection:/,
    )
  })

  it('coerces a truthy persisted survivor flag to a boolean true', () => {
    const sharedVaultUser = createMapper().toDomain(createProjection({ isDesignatedSurvivor: 1 as unknown as boolean }))

    expect(sharedVaultUser.props.isDesignatedSurvivor).toBe(true)
  })

  it('coerces a null persisted survivor flag to a boolean false', () => {
    const sharedVaultUser = createMapper().toDomain(
      createProjection({ isDesignatedSurvivor: null as unknown as boolean }),
    )

    expect(sharedVaultUser.props.isDesignatedSurvivor).toBe(false)
  })

  it('maps a shared vault user onto its persisted row', () => {
    const projection = createMapper().toProjection(createDomain())

    expect(projection).toBeInstanceOf(TypeORMSharedVaultUser)
    expect(projection.uuid).toEqual(sharedVaultUserUuid)
    expect(projection.sharedVaultUuid).toEqual(sharedVaultUuid)
    expect(projection.userUuid).toEqual(userUuid)
    expect(projection.permission).toEqual(SharedVaultUserPermission.PERMISSIONS.Write)
    expect(projection.isDesignatedSurvivor).toBe(false)
    expect(projection.createdAtTimestamp).toEqual(123)
    expect(projection.updatedAtTimestamp).toEqual(456)
  })

  it('persists a designated survivor as a boolean true', () => {
    expect(createMapper().toProjection(createDomain(true)).isDesignatedSurvivor).toBe(true)
  })

  it('round trips a shared vault user without altering it', () => {
    const mapper = createMapper()

    expect(mapper.toProjection(mapper.toDomain(createProjection()))).toEqual(createProjection())
  })
})

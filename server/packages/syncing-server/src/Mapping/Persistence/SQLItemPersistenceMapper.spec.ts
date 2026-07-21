import { ContentType, Dates, Timestamps, UniqueEntityId, Uuid } from '@standardnotes/domain-core'

import { Item } from '../../Domain/Item/Item'
import { KeySystemAssociation } from '../../Domain/KeySystem/KeySystemAssociation'
import { SharedVaultAssociation } from '../../Domain/SharedVault/SharedVaultAssociation'
import { SQLItem } from '../../Infra/TypeORM/SQLItem'

import { SQLItemPersistenceMapper } from './SQLItemPersistenceMapper'

describe('SQLItemPersistenceMapper', () => {
  const itemUuid = '00000000-0000-0000-0000-000000000001'
  const userUuid = '00000000-0000-0000-0000-000000000002'
  const sharedVaultUuid = '00000000-0000-0000-0000-000000000003'
  const lastEditedBy = '00000000-0000-0000-0000-000000000004'
  const duplicateOf = '00000000-0000-0000-0000-000000000005'
  const sessionUuid = '00000000-0000-0000-0000-000000000006'

  const createMapper = () => new SQLItemPersistenceMapper()

  const createProjection = (overrides: Partial<SQLItem> = {}): SQLItem => {
    const typeorm = new SQLItem()
    typeorm.uuid = itemUuid
    typeorm.duplicateOf = null
    typeorm.itemsKeyId = 'items-key-id'
    typeorm.content = 'content'
    typeorm.contentType = ContentType.TYPES.Note
    typeorm.contentSize = 7
    typeorm.encItemKey = 'enc-item-key'
    typeorm.authHash = 'auth-hash'
    typeorm.userUuid = userUuid
    typeorm.deleted = false
    typeorm.createdAt = new Date(1)
    typeorm.updatedAt = new Date(2)
    typeorm.createdAtTimestamp = 123
    typeorm.updatedAtTimestamp = 456
    typeorm.updatedWithSession = null
    typeorm.lastEditedBy = null
    typeorm.sharedVaultUuid = null
    typeorm.keySystemIdentifier = null

    return Object.assign(typeorm, overrides)
  }

  const createDomain = (overrides: Partial<Parameters<typeof Item.create>[0]> = {}) =>
    Item.create(
      {
        duplicateOf: null,
        itemsKeyId: 'items-key-id',
        content: 'content',
        contentType: ContentType.create(ContentType.TYPES.Note).getValue(),
        contentSize: 7,
        encItemKey: 'enc-item-key',
        authHash: 'auth-hash',
        userUuid: Uuid.create(userUuid).getValue(),
        deleted: false,
        updatedWithSession: null,
        dates: Dates.create(new Date(1), new Date(2)).getValue(),
        timestamps: Timestamps.create(123, 456).getValue(),
        ...overrides,
      },
      new UniqueEntityId(itemUuid),
    ).getValue()

  describe('toDomain', () => {
    it('rebuilds a bare item from its persisted row', () => {
      const item = createMapper().toDomain(createProjection())

      expect(item.id.toString()).toEqual(itemUuid)
      expect(item.props.duplicateOf).toBeNull()
      expect(item.props.itemsKeyId).toEqual('items-key-id')
      expect(item.props.content).toEqual('content')
      expect(item.props.contentType.value).toEqual(ContentType.TYPES.Note)
      expect(item.props.contentSize).toEqual(7)
      expect(item.props.encItemKey).toEqual('enc-item-key')
      expect(item.props.authHash).toEqual('auth-hash')
      expect(item.props.userUuid.value).toEqual(userUuid)
      expect(item.props.deleted).toBe(false)
      expect(item.props.dates.createdAt).toEqual(new Date(1))
      expect(item.props.dates.updatedAt).toEqual(new Date(2))
      expect(item.props.timestamps.createdAt).toEqual(123)
      expect(item.props.timestamps.updatedAt).toEqual(456)
      expect(item.props.updatedWithSession).toBeNull()
      expect(item.props.sharedVaultAssociation).toBeUndefined()
      expect(item.props.keySystemAssociation).toBeUndefined()
    })

    it('rejects a row with a malformed item uuid', () => {
      expect(() => createMapper().toDomain(createProjection({ uuid: 'not-a-uuid' }))).toThrow(
        /^Failed to create item from projection:/,
      )
    })

    it('rejects a row with a malformed duplicate_of uuid', () => {
      expect(() => createMapper().toDomain(createProjection({ duplicateOf: 'not-a-uuid' }))).toThrow(
        /^Failed to create item from projection:/,
      )
    })

    it('rejects a row with an unknown content type', () => {
      expect(() => createMapper().toDomain(createProjection({ contentType: 'Nonsense' }))).toThrow(
        /^Failed to create item from projection:/,
      )
    })

    it('rejects a row with a malformed owner uuid', () => {
      expect(() => createMapper().toDomain(createProjection({ userUuid: 'not-a-uuid' }))).toThrow(
        /^Failed to create item from projection:/,
      )
    })

    it('rejects a row whose dates are not dates', () => {
      expect(() => createMapper().toDomain(createProjection({ createdAt: 'yesterday' as unknown as Date }))).toThrow(
        /^Failed to create item from projection:/,
      )
    })

    it('rejects a row whose timestamps are not numbers', () => {
      expect(() =>
        createMapper().toDomain(createProjection({ updatedAtTimestamp: '456' as unknown as number })),
      ).toThrow(/^Failed to create item from projection:/)
    })

    it('rejects a row with a malformed updated_with_session uuid', () => {
      expect(() => createMapper().toDomain(createProjection({ updatedWithSession: 'not-a-uuid' }))).toThrow(
        /^Failed to create item from projection:/,
      )
    })

    it('rejects a row with a malformed shared vault uuid', () => {
      expect(() => createMapper().toDomain(createProjection({ sharedVaultUuid: 'not-a-uuid', lastEditedBy }))).toThrow(
        /^Failed to create item from projection:/,
      )
    })

    it('rejects a row with a malformed last_edited_by uuid', () => {
      expect(() => createMapper().toDomain(createProjection({ sharedVaultUuid, lastEditedBy: 'not-a-uuid' }))).toThrow(
        /^Failed to create item from projection:/,
      )
    })

    it('restores the shared vault association when both halves are persisted', () => {
      const item = createMapper().toDomain(createProjection({ sharedVaultUuid, lastEditedBy }))

      expect(item.props.sharedVaultAssociation?.props.sharedVaultUuid.value).toEqual(sharedVaultUuid)
      expect(item.props.sharedVaultAssociation?.props.lastEditedBy.value).toEqual(lastEditedBy)
    })

    it('leaves the shared vault association unset when only one half is persisted', () => {
      expect(
        createMapper().toDomain(createProjection({ sharedVaultUuid, lastEditedBy: null })).props.sharedVaultAssociation,
      ).toBeUndefined()
      expect(
        createMapper().toDomain(createProjection({ sharedVaultUuid: null, lastEditedBy })).props.sharedVaultAssociation,
      ).toBeUndefined()
    })

    it('restores the key system association when persisted', () => {
      const item = createMapper().toDomain(createProjection({ keySystemIdentifier: 'key-system-identifier' }))

      expect(item.props.keySystemAssociation?.props.keySystemIdentifier).toEqual('key-system-identifier')
    })

    it('restores the duplicate_of and updated_with_session uuids when persisted', () => {
      const item = createMapper().toDomain(createProjection({ duplicateOf, updatedWithSession: sessionUuid }))

      expect(item.props.duplicateOf?.value).toEqual(duplicateOf)
      expect(item.props.updatedWithSession?.value).toEqual(sessionUuid)
    })

    it('coerces a numeric persisted deleted flag to a boolean', () => {
      expect(createMapper().toDomain(createProjection({ deleted: 1 as unknown as boolean })).props.deleted).toBe(true)
      expect(createMapper().toDomain(createProjection({ deleted: 0 as unknown as boolean })).props.deleted).toBe(false)
    })

    it('recomputes the content size when the row has none rather than persisting null', () => {
      const item = createMapper().toDomain(createProjection({ contentSize: null }))

      expect(item.props.contentSize).toBeGreaterThan(0)
    })
  })

  describe('toProjection', () => {
    it('maps a bare item onto its persisted row', () => {
      const projection = createMapper().toProjection(createDomain())

      expect(projection).toBeInstanceOf(SQLItem)
      expect(projection.uuid).toEqual(itemUuid)
      expect(projection.duplicateOf).toBeNull()
      expect(projection.itemsKeyId).toEqual('items-key-id')
      expect(projection.content).toEqual('content')
      expect(projection.contentType).toEqual(ContentType.TYPES.Note)
      expect(projection.contentSize).toEqual(7)
      expect(projection.encItemKey).toEqual('enc-item-key')
      expect(projection.authHash).toEqual('auth-hash')
      expect(projection.userUuid).toEqual(userUuid)
      expect(projection.deleted).toBe(false)
      expect(projection.createdAt).toEqual(new Date(1))
      expect(projection.updatedAt).toEqual(new Date(2))
      expect(projection.createdAtTimestamp).toEqual(123)
      expect(projection.updatedAtTimestamp).toEqual(456)
      expect(projection.updatedWithSession).toBeNull()
      expect(projection.lastEditedBy).toBeNull()
      expect(projection.sharedVaultUuid).toBeNull()
      expect(projection.keySystemIdentifier).toBeNull()
    })

    it('persists both halves of a shared vault association', () => {
      const projection = createMapper().toProjection(
        createDomain({
          sharedVaultAssociation: SharedVaultAssociation.create({
            sharedVaultUuid: Uuid.create(sharedVaultUuid).getValue(),
            lastEditedBy: Uuid.create(lastEditedBy).getValue(),
          }).getValue(),
        }),
      )

      expect(projection.sharedVaultUuid).toEqual(sharedVaultUuid)
      expect(projection.lastEditedBy).toEqual(lastEditedBy)
    })

    it('persists the key system identifier', () => {
      const projection = createMapper().toProjection(
        createDomain({ keySystemAssociation: KeySystemAssociation.create('key-system-identifier').getValue() }),
      )

      expect(projection.keySystemIdentifier).toEqual('key-system-identifier')
    })

    it('persists the duplicate_of and updated_with_session uuids', () => {
      const projection = createMapper().toProjection(
        createDomain({
          duplicateOf: Uuid.create(duplicateOf).getValue(),
          updatedWithSession: Uuid.create(sessionUuid).getValue(),
        }),
      )

      expect(projection.duplicateOf).toEqual(duplicateOf)
      expect(projection.updatedWithSession).toEqual(sessionUuid)
    })

    it('persists a missing content size as null', () => {
      const domain = createDomain()
      delete domain.props.contentSize

      expect(createMapper().toProjection(domain).contentSize).toBeNull()
    })

    it('normalises the deleted flag to a boolean', () => {
      expect(createMapper().toProjection(createDomain({ deleted: true })).deleted).toBe(true)
      expect(createMapper().toProjection(createDomain({ deleted: undefined as never })).deleted).toBe(false)
    })
  })

  it('round trips a fully associated item without altering it', () => {
    const mapper = createMapper()
    const projection = createProjection({
      duplicateOf,
      updatedWithSession: sessionUuid,
      sharedVaultUuid,
      lastEditedBy,
      keySystemIdentifier: 'key-system-identifier',
      deleted: true,
    })

    expect(mapper.toProjection(mapper.toDomain(projection))).toEqual(projection)
  })
})

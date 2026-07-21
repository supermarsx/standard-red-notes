import { ContentType, Dates, Timestamps, UniqueEntityId, Uuid } from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'

import { Item } from '../../Domain/Item/Item'
import { KeySystemAssociation } from '../../Domain/KeySystem/KeySystemAssociation'
import { SharedVaultAssociation } from '../../Domain/SharedVault/SharedVaultAssociation'

import { SavedItemHttpMapper } from './SavedItemHttpMapper'

describe('SavedItemHttpMapper', () => {
  let timer: TimerInterface

  const itemUuid = '00000000-0000-0000-0000-000000000001'
  const userUuid = '00000000-0000-0000-0000-000000000002'
  const sharedVaultUuid = '00000000-0000-0000-0000-000000000003'
  const lastEditedBy = '00000000-0000-0000-0000-000000000004'
  const duplicateOf = '00000000-0000-0000-0000-000000000005'

  const createMapper = () => new SavedItemHttpMapper(timer)

  const createItem = (overrides: Partial<Parameters<typeof Item.create>[0]> = {}) =>
    Item.create(
      {
        duplicateOf: null,
        itemsKeyId: 'items-key-id',
        content: 'content',
        contentType: ContentType.create(ContentType.TYPES.Note).getValue(),
        encItemKey: 'enc-item-key',
        authHash: 'auth-hash',
        userUuid: Uuid.create(userUuid).getValue(),
        deleted: false,
        updatedWithSession: null,
        dates: Dates.create(new Date(123), new Date(456)).getValue(),
        timestamps: Timestamps.create(123, 456).getValue(),
        ...overrides,
      },
      new UniqueEntityId(itemUuid),
    ).getValue()

  beforeEach(() => {
    timer = {} as jest.Mocked<TimerInterface>
    timer.convertMicrosecondsToStringDate = jest.fn().mockImplementation((ms: number) => `date-${ms}`)
  })

  it('maps a saved item onto the acknowledgement representation', () => {
    const projection = createMapper().toProjection(createItem())

    expect(projection).toEqual({
      uuid: itemUuid,
      duplicate_of: null,
      content_type: ContentType.TYPES.Note,
      auth_hash: 'auth-hash',
      deleted: false,
      created_at: 'date-123',
      created_at_timestamp: 123,
      updated_at: 'date-456',
      updated_at_timestamp: 456,
      key_system_identifier: null,
      shared_vault_uuid: null,
      user_uuid: userUuid,
      last_edited_by_uuid: null,
    })
  })

  it('never echoes the item content or encryption key back to the client', () => {
    const projection = createMapper().toProjection(createItem())

    expect(projection).not.toHaveProperty('content')
    expect(projection).not.toHaveProperty('enc_item_key')
    expect(projection).not.toHaveProperty('items_key_id')
  })

  it('exposes the duplicate_of uuid when present', () => {
    const projection = createMapper().toProjection(createItem({ duplicateOf: Uuid.create(duplicateOf).getValue() }))

    expect(projection.duplicate_of).toEqual(duplicateOf)
  })

  it('exposes the shared vault uuid and last editor of a shared vault item', () => {
    const projection = createMapper().toProjection(
      createItem({
        sharedVaultAssociation: SharedVaultAssociation.create({
          sharedVaultUuid: Uuid.create(sharedVaultUuid).getValue(),
          lastEditedBy: Uuid.create(lastEditedBy).getValue(),
        }).getValue(),
      }),
    )

    expect(projection.shared_vault_uuid).toEqual(sharedVaultUuid)
    expect(projection.last_edited_by_uuid).toEqual(lastEditedBy)
  })

  it('exposes the key system identifier of a key system associated item', () => {
    const projection = createMapper().toProjection(
      createItem({ keySystemAssociation: KeySystemAssociation.create('key-system-identifier').getValue() }),
    )

    expect(projection.key_system_identifier).toEqual('key-system-identifier')
  })

  it('normalises a deleted item to a boolean', () => {
    expect(createMapper().toProjection(createItem({ deleted: true })).deleted).toBe(true)
    expect(createMapper().toProjection(createItem({ deleted: undefined as never })).deleted).toBe(false)
  })

  it('refuses to map an http representation back to the domain', () => {
    expect(() => createMapper().toDomain({} as never)).toThrow(
      'Mapping from http representation to domain is not implemented.',
    )
  })
})

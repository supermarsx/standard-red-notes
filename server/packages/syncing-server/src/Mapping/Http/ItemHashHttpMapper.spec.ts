import { ItemHash } from '../../Domain/Item/ItemHash'

import { ItemHashHttpMapper } from './ItemHashHttpMapper'

describe('ItemHashHttpMapper', () => {
  const createMapper = () => new ItemHashHttpMapper()

  it('echoes every property of the item hash back verbatim', () => {
    const props = {
      uuid: '00000000-0000-0000-0000-000000000001',
      user_uuid: '00000000-0000-0000-0000-000000000002',
      content: 'content',
      content_type: 'Note',
      deleted: false,
      duplicate_of: null,
      auth_hash: 'auth-hash',
      enc_item_key: 'enc-item-key',
      items_key_id: 'items-key-id',
      key_system_identifier: null,
      shared_vault_uuid: null,
      created_at: '2023-01-01',
      created_at_timestamp: 123,
      updated_at: '2023-01-02',
      updated_at_timestamp: 456,
    }

    expect(createMapper().toProjection(ItemHash.create(props).getValue())).toEqual(props)
  })

  it('preserves a shared vault association on the hash', () => {
    const sharedVaultUuid = '00000000-0000-0000-0000-000000000003'

    const projection = createMapper().toProjection(
      ItemHash.create({
        uuid: '00000000-0000-0000-0000-000000000001',
        user_uuid: '00000000-0000-0000-0000-000000000002',
        content_type: 'Note',
        key_system_identifier: 'key-system-identifier',
        shared_vault_uuid: sharedVaultUuid,
      }).getValue(),
    )

    expect(projection.shared_vault_uuid).toEqual(sharedVaultUuid)
    expect(projection.key_system_identifier).toEqual('key-system-identifier')
  })

  it('returns a copy rather than the live props object', () => {
    const itemHash = ItemHash.create({
      uuid: '00000000-0000-0000-0000-000000000001',
      user_uuid: '00000000-0000-0000-0000-000000000002',
      content_type: 'Note',
      key_system_identifier: null,
      shared_vault_uuid: null,
    }).getValue()

    const projection = createMapper().toProjection(itemHash)
    projection.content_type = 'tampered'

    expect(itemHash.props.content_type).toEqual('Note')
  })

  it('refuses to map an http representation back to the domain', () => {
    expect(() => createMapper().toDomain({} as never)).toThrow(
      'Mapping from http representation to domain is not implemented.',
    )
  })
})

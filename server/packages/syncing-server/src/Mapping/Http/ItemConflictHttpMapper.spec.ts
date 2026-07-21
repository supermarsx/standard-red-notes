import { ConflictType } from '@standardnotes/responses'
import { MapperInterface } from '@standardnotes/domain-core'

import { Item } from '../../Domain/Item/Item'
import { ItemHash } from '../../Domain/Item/ItemHash'
import { ItemHttpRepresentation } from './ItemHttpRepresentation'
import { ItemHashHttpRepresentation } from './ItemHashHttpRepresentation'

import { ItemConflictHttpMapper } from './ItemConflictHttpMapper'

describe('ItemConflictHttpMapper', () => {
  let itemMapper: MapperInterface<Item, ItemHttpRepresentation>
  let itemHashMapper: MapperInterface<ItemHash, ItemHashHttpRepresentation>

  const serverItemProjection = { uuid: 'server-item' } as ItemHttpRepresentation
  const unsavedItemProjection = { uuid: 'unsaved-item' } as ItemHashHttpRepresentation

  const createMapper = () => new ItemConflictHttpMapper(itemMapper, itemHashMapper)

  beforeEach(() => {
    itemMapper = {} as jest.Mocked<MapperInterface<Item, ItemHttpRepresentation>>
    itemMapper.toProjection = jest.fn().mockReturnValue(serverItemProjection)
    itemMapper.toDomain = jest.fn()

    itemHashMapper = {} as jest.Mocked<MapperInterface<ItemHash, ItemHashHttpRepresentation>>
    itemHashMapper.toProjection = jest.fn().mockReturnValue(unsavedItemProjection)
    itemHashMapper.toDomain = jest.fn()
  })

  it('maps a conflict that carries only a type', () => {
    const projection = createMapper().toProjection({ type: ConflictType.UuidConflict })

    expect(projection).toEqual({ type: ConflictType.UuidConflict })
    expect(itemMapper.toProjection).not.toHaveBeenCalled()
    expect(itemHashMapper.toProjection).not.toHaveBeenCalled()
  })

  it('delegates the server item to the item mapper', () => {
    const serverItem = { id: 'server' } as unknown as Item

    const projection = createMapper().toProjection({ type: ConflictType.ConflictingData, serverItem })

    expect(itemMapper.toProjection).toHaveBeenCalledWith(serverItem)
    expect(projection.server_item).toEqual(serverItemProjection)
    expect(projection.unsaved_item).toBeUndefined()
  })

  it('delegates the unsaved item to the item hash mapper', () => {
    const unsavedItem = { props: {} } as unknown as ItemHash

    const projection = createMapper().toProjection({ type: ConflictType.ConflictingData, unsavedItem })

    expect(itemHashMapper.toProjection).toHaveBeenCalledWith(unsavedItem)
    expect(projection.unsaved_item).toEqual(unsavedItemProjection)
    expect(projection.server_item).toBeUndefined()
  })

  it('maps both sides of a conflict when both are present', () => {
    const serverItem = { id: 'server' } as unknown as Item
    const unsavedItem = { props: {} } as unknown as ItemHash

    const projection = createMapper().toProjection({
      type: ConflictType.ConflictingData,
      serverItem,
      unsavedItem,
    })

    expect(projection).toEqual({
      type: ConflictType.ConflictingData,
      server_item: serverItemProjection,
      unsaved_item: unsavedItemProjection,
    })
  })

  it('refuses to map an http representation back to the domain', () => {
    expect(() => createMapper().toDomain({} as never)).toThrow(
      'Mapping from http representation to domain is not implemented.',
    )
  })
})

import { ContentType } from '@standardnotes/domain-core'
import { FillItemContent, ItemContent } from '../../Abstract/Content/ItemContent'
import { ConflictStrategy } from '../../Abstract/Item'
import {
  DecryptedPayload,
  EncryptedPayload,
  FullyFormedPayloadInterface,
  PayloadTimestampDefaults,
} from '../../Abstract/Payload'
import { ItemsKeyContent } from '../../Syncable/ItemsKey/ItemsKeyInterface'
import { ImmutablePayloadCollection } from '../Collection/Payload/ImmutablePayloadCollection'
import { PayloadCollection } from '../Collection/Payload/PayloadCollection'
import { HistoryMap } from '../History'
import { ConflictDelta } from './Conflict'

describe('conflict delta', () => {
  const historyMap = {} as HistoryMap

  const createBaseCollection = (payload: FullyFormedPayloadInterface) => {
    const baseCollection = new PayloadCollection()
    baseCollection.set(payload)
    return ImmutablePayloadCollection.FromCollection(baseCollection)
  }

  const createDecryptedItemsKey = (uuid: string, key: string, timestamp = 0) => {
    return new DecryptedPayload<ItemsKeyContent>({
      uuid: uuid,
      content_type: ContentType.TYPES.ItemsKey,
      content: FillItemContent<ItemsKeyContent>({
        itemsKey: key,
      }),
      ...PayloadTimestampDefaults(),
      updated_at_timestamp: timestamp,
    })
  }

  const createErroredItemsKey = (uuid: string, timestamp = 0) => {
    return new EncryptedPayload({
      uuid: uuid,
      content_type: ContentType.TYPES.ItemsKey,
      content: '004:...',
      enc_item_key: '004:...',
      items_key_id: undefined,
      errorDecrypting: true,
      waitingForKey: false,
      ...PayloadTimestampDefaults(),
      updated_at_timestamp: timestamp,
    })
  }

  it('when apply is an items key, logic should be diverted to items key delta', () => {
    const basePayload = createDecryptedItemsKey('123', 'secret')

    const baseCollection = createBaseCollection(basePayload)

    const applyPayload = createDecryptedItemsKey('123', 'secret', 2)

    const delta = new ConflictDelta(baseCollection, basePayload, applyPayload, historyMap)

    const mocked = (delta.getConflictStrategy = jest.fn())

    delta.result()

    expect(mocked).toHaveBeenCalledTimes(0)
  })

  it('if apply payload is errored but base payload is not, should duplicate base and keep apply', () => {
    const basePayload = createDecryptedItemsKey('123', 'secret')

    const baseCollection = createBaseCollection(basePayload)

    const applyPayload = createErroredItemsKey('123', 2)

    const delta = new ConflictDelta(baseCollection, basePayload, applyPayload, historyMap)

    expect(delta.getConflictStrategy()).toBe(ConflictStrategy.DuplicateBaseKeepApply)
  })

  it('if base payload is errored but apply is not, should keep base duplicate apply', () => {
    const basePayload = createErroredItemsKey('123', 2)

    const baseCollection = createBaseCollection(basePayload)

    const applyPayload = createDecryptedItemsKey('123', 'secret')

    const delta = new ConflictDelta(baseCollection, basePayload, applyPayload, historyMap)

    expect(delta.getConflictStrategy()).toBe(ConflictStrategy.KeepBaseDuplicateApply)
  })

  it('if base and apply are errored, should keep apply', () => {
    const basePayload = createErroredItemsKey('123', 2)

    const baseCollection = createBaseCollection(basePayload)

    const applyPayload = createErroredItemsKey('123', 3)

    const delta = new ConflictDelta(baseCollection, basePayload, applyPayload, historyMap)

    expect(delta.getConflictStrategy()).toBe(ConflictStrategy.KeepApply)
  })

  const createDecryptedNote = (uuid: string, title: string, conflictOf?: string, timestamp = 0) => {
    return new DecryptedPayload({
      uuid: uuid,
      content_type: ContentType.TYPES.Note,
      content: FillItemContent({
        title,
        ...(conflictOf ? { conflict_of: conflictOf } : {}),
      } as Partial<ItemContent>),
      ...PayloadTimestampDefaults(),
      updated_at_timestamp: timestamp,
    })
  }

  it('dedupes against a NON-first existing conflict (scans all conflictsOf), not just the first', () => {
    const baseUuid = 'base-uuid'
    const basePayload = createDecryptedNote(baseUuid, 'base title')

    // Two existing conflict duplicates of the base item. The incoming content
    // matches the SECOND one; the old code only compared the first and would
    // have created a redundant duplicate.
    const firstConflict = createDecryptedNote('conflict-1', 'some other title', baseUuid)
    const secondConflict = createDecryptedNote('conflict-2', 'incoming title', baseUuid)

    const collection = new PayloadCollection()
    collection.set(basePayload)
    collection.set(firstConflict)
    collection.set(secondConflict)
    const baseCollection = ImmutablePayloadCollection.FromCollection(collection)

    // Incoming payload for the base uuid whose content matches secondConflict.
    const applyPayload = createDecryptedNote(baseUuid, 'incoming title', undefined, 5)

    const delta = new ConflictDelta(baseCollection, basePayload, applyPayload, historyMap)

    expect(delta.getConflictStrategy()).toBe(ConflictStrategy.KeepBase)
  })

  it('still creates a conflict when incoming matches no existing conflict', () => {
    const baseUuid = 'base-uuid-2'
    const basePayload = createDecryptedNote(baseUuid, 'base title')

    const firstConflict = createDecryptedNote('conflict-a', 'title a', baseUuid)
    const secondConflict = createDecryptedNote('conflict-b', 'title b', baseUuid)

    const collection = new PayloadCollection()
    collection.set(basePayload)
    collection.set(firstConflict)
    collection.set(secondConflict)
    const baseCollection = ImmutablePayloadCollection.FromCollection(collection)

    const applyPayload = createDecryptedNote(baseUuid, 'a brand new conflicting title', undefined, 5)

    const delta = new ConflictDelta(baseCollection, basePayload, applyPayload, historyMap)

    // No existing conflict equals the incoming content => not KeepBase-by-dedupe.
    expect(delta.getConflictStrategy()).not.toBe(ConflictStrategy.KeepBase)
  })

  it('if keep base strategy, always use the apply payloads updated_at_timestamp', () => {
    const basePayload = createDecryptedItemsKey('123', 'secret', 2)

    const baseCollection = createBaseCollection(basePayload)

    const applyPayload = createDecryptedItemsKey('123', 'other secret', 1)

    const delta = new ConflictDelta(baseCollection, basePayload, applyPayload, historyMap)

    expect(delta.getConflictStrategy()).toBe(ConflictStrategy.KeepBaseDuplicateApply)

    const result = delta.result()

    expect(result.emits).toHaveLength(1)

    expect(result.emits[0].updated_at_timestamp).toEqual(applyPayload.updated_at_timestamp)
  })
})

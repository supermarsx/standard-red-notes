import { ContentType } from '@standardnotes/domain-core'
import { UuidGenerator } from '@standardnotes/utils'
import { FillItemContent, ItemContent } from '../../Abstract/Content/ItemContent'
import {
  DecryptedPayload,
  DeletedPayload,
  EncryptedPayload,
  FullyFormedPayloadInterface,
  isDecryptedPayload,
  isDeletedPayload,
  isEncryptedPayload,
  PayloadTimestampDefaults,
} from '../../Abstract/Payload'
import { PayloadCollection } from '../Collection/Payload/PayloadCollection'
import { ImmutablePayloadCollection } from '../Collection/Payload/ImmutablePayloadCollection'
import { ItemsKeyContent } from '../../Syncable/ItemsKey/ItemsKeyInterface'
import { ServerSyncPushContextualPayload } from '../../Abstract/Contextual/ServerSyncPush'
import { DeltaRemoteRetrieved } from './RemoteRetrieved'

describe('remote retrieved delta', () => {
  it('if local items key is decrypted, incoming encrypted should not overwrite', async () => {
    const baseCollection = new PayloadCollection()
    const basePayload = new DecryptedPayload<ItemsKeyContent>({
      uuid: '123',
      content_type: ContentType.TYPES.ItemsKey,
      content: FillItemContent<ItemsKeyContent>({
        itemsKey: 'secret',
      }),
      ...PayloadTimestampDefaults(),
      updated_at_timestamp: 1,
    })

    baseCollection.set(basePayload)

    const payloadToIgnore = new EncryptedPayload({
      uuid: '123',
      content_type: ContentType.TYPES.ItemsKey,
      content: '004:...',
      enc_item_key: '004:...',
      items_key_id: undefined,
      errorDecrypting: false,
      waitingForKey: false,
      ...PayloadTimestampDefaults(),
      updated_at_timestamp: 2,
    })

    const delta = new DeltaRemoteRetrieved(
      ImmutablePayloadCollection.FromCollection(baseCollection),
      ImmutablePayloadCollection.WithPayloads([payloadToIgnore]),
      [],
      {},
    )

    const result = delta.result()

    const updatedBasePayload = result.emits?.[0] as DecryptedPayload<ItemsKeyContent>

    expect(updatedBasePayload.content.itemsKey).toBe('secret')
    expect(updatedBasePayload.updated_at_timestamp).toBe(2)
    expect(updatedBasePayload.dirty).toBeFalsy()

    const ignored = result.ignored?.[0] as EncryptedPayload
    expect(ignored).toBeTruthy()
    expect(isEncryptedPayload(ignored)).toBe(true)
  })

  /**
   * An incoming DELETED payload is not a decrypted payload, so it used to be filtered out of
   * the conflict loop — but it had already been removed from the normal emit path by being
   * pushed onto `conflicted`. The delta therefore emitted nothing at all: the server's
   * deletion was silently dropped and the dirty local item survived to be pushed back up,
   * resurrecting an item the user deleted on another device.
   */
  describe('incoming deletion must not be dropped', () => {
    const NOTE_UUID = 'note-uuid'
    const LOCAL_EDIT = 'my un-synced edit'

    let uuidCounter = 0

    beforeEach(() => {
      uuidCounter = 0
      UuidGenerator.SetGenerator(() => `generated-uuid-${++uuidCounter}`)
    })

    const collectionOf = (...payloads: FullyFormedPayloadInterface[]) => {
      const collection = new PayloadCollection()
      payloads.forEach((payload) => collection.set(payload))
      return ImmutablePayloadCollection.FromCollection(collection)
    }

    const localNote = (dirty: boolean) =>
      new DecryptedPayload({
        uuid: NOTE_UUID,
        content_type: ContentType.TYPES.Note,
        content: FillItemContent({ title: 'My note', text: LOCAL_EDIT } as Partial<ItemContent>),
        dirty,
        ...PayloadTimestampDefaults(),
        updated_at_timestamp: 1,
      })

    const erroredLocalNote = () =>
      new EncryptedPayload({
        uuid: NOTE_UUID,
        content_type: ContentType.TYPES.Note,
        content: '004:...',
        enc_item_key: '004:...',
        items_key_id: undefined,
        errorDecrypting: true,
        waitingForKey: false,
        dirty: true,
        ...PayloadTimestampDefaults(),
        updated_at_timestamp: 1,
      })

    const incomingDeletion = () =>
      new DeletedPayload({
        uuid: NOTE_UUID,
        content_type: ContentType.TYPES.Note,
        content: undefined,
        deleted: true,
        ...PayloadTimestampDefaults(),
        updated_at_timestamp: 99,
      })

    const savedOrSaving = (uuid: string) => [{ uuid }] as ServerSyncPushContextualPayload[]

    it('preserves a DIRTY local edit as a conflict copy and still applies the deletion', () => {
      const base = localNote(true)

      const delta = new DeltaRemoteRetrieved(collectionOf(base), collectionOf(incomingDeletion()), [], {})
      const emits = delta.result().emits

      // The deletion is applied to the original uuid, and is discardable so the item
      // is actually removed from the collection rather than re-pushed.
      const tombstone = emits.find((payload) => payload.uuid === NOTE_UUID)
      expect(tombstone).toBeTruthy()
      expect(isDeletedPayload(tombstone!)).toBe(true)
      expect(tombstone!.dirty).toBeFalsy()
      expect((tombstone as DeletedPayload).discardable).toBe(true)

      // The un-synced edit survives as a fresh conflict copy linked to the original.
      const copy = emits.find((payload) => payload.uuid !== NOTE_UUID)
      expect(copy).toBeTruthy()
      expect(isDecryptedPayload(copy!)).toBe(true)
      expect(copy!.duplicate_of).toEqual(NOTE_UUID)
      expect((copy as DecryptedPayload).content.conflict_of).toEqual(NOTE_UUID)
      expect(((copy as DecryptedPayload).content as { text?: string }).text).toEqual(LOCAL_EDIT)
      expect(copy!.dirty).toBe(true)
      expect(copy!.deleted).toBeFalsy()
    })

    it('applies a deletion for an item currently being saved, rather than dropping it', () => {
      const base = localNote(false)

      const delta = new DeltaRemoteRetrieved(
        collectionOf(base),
        collectionOf(incomingDeletion()),
        savedOrSaving(NOTE_UUID),
        {},
      )
      const emits = delta.result().emits

      expect(emits).toHaveLength(1)
      expect(emits[0].uuid).toEqual(NOTE_UUID)
      expect(isDeletedPayload(emits[0])).toBe(true)
      expect((emits[0] as DeletedPayload).discardable).toBe(true)
    })

    it('applies a deletion against an ERRORED local base without minting a dirty tombstone duplicate', () => {
      const base = erroredLocalNote()

      const delta = new DeltaRemoteRetrieved(
        collectionOf(base),
        collectionOf(incomingDeletion()),
        savedOrSaving(NOTE_UUID),
        {},
      )
      const emits = delta.result().emits

      // An errored base holds no readable edit to preserve. The deletion applies directly;
      // no duplicate is created, and in particular no dirty (non-discardable) tombstone copy.
      expect(emits).toHaveLength(1)
      expect(emits[0].uuid).toEqual(NOTE_UUID)
      expect(isDeletedPayload(emits[0])).toBe(true)
      expect(emits.some((payload) => isDeletedPayload(payload) && payload.dirty)).toBe(false)
    })

    it('ignores a deletion for an item we hold no local copy of', () => {
      // Nothing local to resurrect or preserve, so there is no work to do.
      const delta = new DeltaRemoteRetrieved(
        collectionOf(),
        collectionOf(incomingDeletion()),
        savedOrSaving(NOTE_UUID),
        {},
      )

      expect(delta.result().emits).toHaveLength(0)
    })

    it('REGRESSION: a CLEAN local item takes the deletion alone, with no conflict copy', () => {
      const base = localNote(false)

      const delta = new DeltaRemoteRetrieved(collectionOf(base), collectionOf(incomingDeletion()), [], {})
      const emits = delta.result().emits

      expect(emits).toHaveLength(1)
      expect(emits[0].uuid).toEqual(NOTE_UUID)
      expect(isDeletedPayload(emits[0])).toBe(true)
      expect(emits[0].dirty).toBeFalsy()
      expect(emits.some((payload) => payload.uuid !== NOTE_UUID)).toBe(false)
    })

    it('REGRESSION: an incoming ERRORED payload against a dirty base is still left for a later sync', () => {
      const base = localNote(true)
      const incomingErrored = new EncryptedPayload({
        uuid: NOTE_UUID,
        content_type: ContentType.TYPES.Note,
        content: '004:...',
        enc_item_key: '004:...',
        items_key_id: undefined,
        errorDecrypting: true,
        waitingForKey: false,
        ...PayloadTimestampDefaults(),
        updated_at_timestamp: 99,
      })

      const delta = new DeltaRemoteRetrieved(collectionOf(base), collectionOf(incomingErrored), [], {})

      expect(delta.result().emits).toHaveLength(0)
    })
  })
})

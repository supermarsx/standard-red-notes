import { ContentType } from '@standardnotes/domain-core'
import { UuidGenerator } from '@standardnotes/utils'
import { FillItemContent, ItemContent } from '../../Abstract/Content/ItemContent'
import { ConflictStrategy } from '../../Abstract/Item'
import {
  DecryptedPayload,
  DeletedPayload,
  FullyFormedPayloadInterface,
  isDecryptedPayload,
  isDeletedPayload,
  PayloadSource,
  PayloadTimestampDefaults,
} from '../../Abstract/Payload'
import { ImmutablePayloadCollection } from '../Collection/Payload/ImmutablePayloadCollection'
import { PayloadCollection } from '../Collection/Payload/PayloadCollection'
import { HistoryMap } from '../History'
import { ConflictDelta } from './Conflict'

UuidGenerator.SetGenerator(() => String(Math.random()))

/**
 * Regression coverage for the delete-vs-edit data-loss finding: when the server has
 * DELETED a note (device A) while we hold a genuine un-synced local edit (device B),
 * the conflict strategy must preserve our edit as a fresh conflict copy rather than
 * silently discard it. See GenericItem.strategyWhenConflictingWithItem.
 */
describe('generic item conflict — incoming deletion vs local edit', () => {
  const historyMap = {} as HistoryMap
  const baseUuid = 'note-uuid'

  const createBaseCollection = (payload: FullyFormedPayloadInterface) => {
    const collection = new PayloadCollection()
    collection.set(payload)
    return ImmutablePayloadCollection.FromCollection(collection)
  }

  const createNote = (opts: { title: string; dirty: boolean; source?: PayloadSource }) => {
    return new DecryptedPayload(
      {
        uuid: baseUuid,
        content_type: ContentType.TYPES.Note,
        content: FillItemContent({ title: opts.title } as Partial<ItemContent>),
        dirty: opts.dirty,
        ...PayloadTimestampDefaults(),
        updated_at_timestamp: 1,
      },
      opts.source,
    )
  }

  const createServerDeletion = () => {
    return new DeletedPayload({
      uuid: baseUuid,
      content_type: ContentType.TYPES.Note,
      content: undefined,
      deleted: true,
      ...PayloadTimestampDefaults(),
      updated_at_timestamp: 5,
    })
  }

  it('routes a DIRTY DECRYPTED local edit against an incoming deletion to DuplicateBaseKeepApply', () => {
    const basePayload = createNote({ title: 'my un-synced edit', dirty: true })
    const applyPayload = createServerDeletion()
    const delta = new ConflictDelta(createBaseCollection(basePayload), basePayload, applyPayload, historyMap)

    expect(delta.getConflictStrategy()).toBe(ConflictStrategy.DuplicateBaseKeepApply)
  })

  it('emits BOTH a fresh conflict copy carrying the local edit AND the server deletion on the original uuid', () => {
    const basePayload = createNote({ title: 'my un-synced edit', dirty: true })
    const applyPayload = createServerDeletion()
    const delta = new ConflictDelta(createBaseCollection(basePayload), basePayload, applyPayload, historyMap)

    const emits = delta.result().emits

    // The conflict copy: a fresh decrypted payload, new uuid, marked as a conflict/duplicate
    // of the original, still dirty (needs re-upload), carrying the local edit's content.
    const conflictCopy = emits.find((p) => isDecryptedPayload(p) && p.uuid !== baseUuid)
    expect(conflictCopy).toBeTruthy()
    expect(isDecryptedPayload(conflictCopy!)).toBe(true)
    expect(conflictCopy!.uuid).not.toEqual(baseUuid)
    expect(conflictCopy!.duplicate_of).toEqual(baseUuid)
    expect((conflictCopy as DecryptedPayload).content.conflict_of).toEqual(baseUuid)
    expect(((conflictCopy as DecryptedPayload).content as { title?: string }).title).toEqual('my un-synced edit')
    expect(conflictCopy!.dirty).toBe(true)
    expect(conflictCopy!.deleted).toBeFalsy()

    // The server deletion, applied to the ORIGINAL uuid (cleanly resolved, not dirty).
    const originalResolved = emits.find((p) => p.uuid === baseUuid)
    expect(originalResolved).toBeTruthy()
    expect(isDeletedPayload(originalResolved!)).toBe(true)
    expect(originalResolved!.dirty).toBeFalsy()
  })

  it('NEGATIVE: a CLEAN (non-dirty) local item vs an incoming deletion still just deletes (no conflict copy)', () => {
    const basePayload = createNote({ title: 'already-synced note', dirty: false })
    const applyPayload = createServerDeletion()
    const delta = new ConflictDelta(createBaseCollection(basePayload), basePayload, applyPayload, historyMap)

    expect(delta.getConflictStrategy()).toBe(ConflictStrategy.KeepApply)

    const emits = delta.result().emits
    // Only the deletion of the original uuid is emitted; no fresh conflict copy.
    expect(emits).toHaveLength(1)
    expect(emits[0].uuid).toEqual(baseUuid)
    expect(isDeletedPayload(emits[0])).toBe(true)
    expect(emits.some((p) => p.uuid !== baseUuid)).toBe(false)
  })

  it('leaves the FileImport case untouched: a dirty FileImport-source base vs an incoming deletion keeps base', () => {
    const basePayload = createNote({ title: 'imported note', dirty: true, source: PayloadSource.FileImport })
    const applyPayload = createServerDeletion()
    const delta = new ConflictDelta(createBaseCollection(basePayload), basePayload, applyPayload, historyMap)

    expect(delta.getConflictStrategy()).toBe(ConflictStrategy.KeepBase)
  })
})

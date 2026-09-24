import { ContentType } from '@standardnotes/domain-core'
import { UuidGenerator } from '@standardnotes/utils'
import { FillItemContent, ItemContent } from './Abstract/Content/ItemContent'
import { ConflictStrategy } from './Abstract/Item'
import {
  DecryptedPayload,
  DeletedPayload,
  FullyFormedPayloadInterface,
  isDecryptedPayload,
  isDeletedPayload,
  PayloadTimestampDefaults,
} from './Abstract/Payload'
import { ImmutablePayloadCollection } from './Runtime/Collection/Payload/ImmutablePayloadCollection'
import { PayloadCollection } from './Runtime/Collection/Payload/PayloadCollection'
import { ConflictDelta } from './Runtime/Deltas/Conflict'
import { NotesAndFilesDisplayOptions } from './Runtime/Display'
import { notesAndFilesMatchingOptions } from './Runtime/Display/DisplayOptionsToFilters'
import { ReferenceLookupCollection, SearchableDecryptedItem } from './Runtime/Display/Search/Types'
import { HistoryMap } from './Runtime/History'
import { SNNote } from './Syncable/Note'
import { BuildSmartViews } from './Syncable/SmartView/SmartViewBuilder'
import { SystemViewId } from './Syncable/SmartView/SystemViewId'
import { CreateDecryptedItemFromPayload } from './Utilities/Item/ItemGenerator'
import { PayloadsByAlternatingUuid } from './Utilities/Payload/PayloadsByAlternatingUuid'

/**
 * END-TO-END: the work-recovery chain, as one sequence rather than four isolated units.
 *
 * The journey: a note the user has open disappears from the local store, and the text they
 * had not yet synced must (a) survive somewhere, (b) be linked to what vanished so the UI
 * can find it, and (c) actually be reachable in a list the user can open.
 *
 * Two paths reach that situation and they behave differently:
 *  - DELETION      — a real delete meets a dirty local edit. Produces a `conflict_of` copy.
 *  - ALTERNATION   — a uuid collision re-identifies the item. Produces a `duplicate_of`
 *                    copy and deliberately NO `conflict_of`, because nothing diverged.
 *
 * Every class here is real. The web-side consumers (preferences pane, toast, editor
 * migration) live in another package and cannot be imported from here, so what this file
 * pins is the CONTRACT they key on — the link fields and the list visibility — which is
 * exactly what silently broke before.
 */
const historyMap = {} as HistoryMap
const ORIGINAL_UUID = 'original-note-uuid'
const UNSAVED_TEXT = 'the sentence the user had not yet synced'

let uuidCounter = 0

beforeEach(() => {
  uuidCounter = 0
  UuidGenerator.SetGenerator(() => `generated-uuid-${++uuidCounter}`)
})

const openNoteWithUnsavedEdit = (dirty = true) =>
  new DecryptedPayload({
    uuid: ORIGINAL_UUID,
    content_type: ContentType.TYPES.Note,
    content: FillItemContent({ title: 'My note', text: UNSAVED_TEXT } as Partial<ItemContent>),
    dirty,
    ...PayloadTimestampDefaults(),
    updated_at_timestamp: 1,
  })

const incomingDeletion = () =>
  new DeletedPayload({
    uuid: ORIGINAL_UUID,
    content_type: ContentType.TYPES.Note,
    content: undefined,
    deleted: true,
    ...PayloadTimestampDefaults(),
    updated_at_timestamp: 99,
  })

const immutableOf = (...payloads: FullyFormedPayloadInterface[]) => {
  const collection = new PayloadCollection()
  payloads.forEach((payload) => collection.set(payload))
  return ImmutablePayloadCollection.FromCollection(collection)
}

const referenceCollection = {
  elementsReferencingElement: () => [],
} as unknown as ReferenceLookupCollection

const displayOptions: NotesAndFilesDisplayOptions = {
  includePinned: true,
  includeProtected: true,
  includeTrashed: false,
  includeArchived: false,
}

const listFor = (viewId: SystemViewId, items: SNNote[]) => {
  const view = BuildSmartViews(displayOptions).find((candidate) => candidate.uuid === viewId)!
  return notesAndFilesMatchingOptions(
    { ...displayOptions, views: [view] },
    items as unknown as SearchableDecryptedItem[],
    referenceCollection,
  ).map((item) => item.uuid)
}

const asNotes = (payloads: FullyFormedPayloadInterface[]) =>
  payloads.filter(isDecryptedPayload).map((payload) => CreateDecryptedItemFromPayload(payload) as unknown as SNNote)

describe('work-recovery chain — DELETION path (fully landed)', () => {
  const runDelta = () => {
    const base = openNoteWithUnsavedEdit()
    return new ConflictDelta(immutableOf(base), base, incomingDeletion(), historyMap).result().emits
  }

  it('STEP 1 — the unsaved text survives, and the original uuid becomes a discardable tombstone', () => {
    const emits = runDelta()

    const copy = emits.find((payload) => payload.uuid !== ORIGINAL_UUID)!
    expect(isDecryptedPayload(copy)).toBe(true)
    expect((copy.content as { text?: string }).text).toEqual(UNSAVED_TEXT)
    expect(copy.dirty).toBe(true)

    const tombstone = emits.find((payload) => payload.uuid === ORIGINAL_UUID)!
    expect(isDeletedPayload(tombstone)).toBe(true)
    // `discardable` is what actually removes the item from the store, which is the
    // event the editor detects. A dirty tombstone would linger and be re-pushed.
    expect((tombstone as DeletedPayload).discardable).toBe(true)
  })

  it('STEP 2 — discarding the tombstone really does remove the original from a live collection', () => {
    const emits = runDelta()
    const tombstone = emits.find((payload) => payload.uuid === ORIGINAL_UUID)!

    const collection = new PayloadCollection()
    collection.set(openNoteWithUnsavedEdit())
    expect(collection.find(ORIGINAL_UUID)).toBeTruthy()

    collection.discard(tombstone as DeletedPayload)

    // This is the disappearance the editor reacts to: the uuid stops resolving.
    expect(collection.find(ORIGINAL_UUID)).toBeUndefined()
  })

  it('STEP 3 — the copy carries the link every UI lookup keys on', () => {
    const copy = runDelta().find((payload) => payload.uuid !== ORIGINAL_UUID)!

    // The preferences pane, the conflict toast and the editor rescue scan all match
    // on `conflict_of === <vanished uuid>`. Losing this is what made them silent.
    expect((copy as DecryptedPayload).content.conflict_of).toEqual(ORIGINAL_UUID)
    expect(copy.duplicate_of).toEqual(ORIGINAL_UUID)
    expect(copy.uuid).not.toEqual(ORIGINAL_UUID)
  })

  it('STEP 4 — the copy is hidden from the ordinary list but visible in the Conflicts view', () => {
    const notes = asNotes(runDelta())
    const copyUuid = notes.find((note) => note.uuid !== ORIGINAL_UUID)!.uuid

    // Ordinary lists deliberately exclude conflicted copies...
    expect(listFor(SystemViewId.AllNotes, notes)).not.toContain(copyUuid)
    // ...so the Conflicts view is the in-list route to the preserved work.
    expect(listFor(SystemViewId.Conflicts, notes)).toEqual([copyUuid])
  })

  it('END TO END — a clean local note takes the deletion with nothing preserved and nothing surfaced', () => {
    const base = openNoteWithUnsavedEdit(false)
    const delta = new ConflictDelta(immutableOf(base), base, incomingDeletion(), historyMap)

    expect(delta.getConflictStrategy()).toBe(ConflictStrategy.KeepApply)

    const emits = delta.result().emits
    expect(emits).toHaveLength(1)
    expect(isDeletedPayload(emits[0])).toBe(true)
    expect(listFor(SystemViewId.Conflicts, asNotes(emits))).toEqual([])
  })
})

describe('work-recovery chain — ALTERNATION path (partially landed)', () => {
  const runAlternation = () => {
    const payload = openNoteWithUnsavedEdit()
    return PayloadsByAlternatingUuid(payload, immutableOf(payload))
  }

  it('STEP 1 — the content survives under a new uuid and the old uuid is tombstoned', () => {
    const results = runAlternation()

    const copy = results.find((payload) => payload.uuid !== ORIGINAL_UUID)!
    expect((copy.content as { text?: string }).text).toEqual(UNSAVED_TEXT)

    const tombstone = results.find((payload) => payload.uuid === ORIGINAL_UUID)!
    expect(isDeletedPayload(tombstone)).toBe(true)
    expect((tombstone as DeletedPayload).discardable).toBe(true)
  })

  it('STEP 3 — the copy carries duplicate_of and NO conflict_of, by design', () => {
    const copy = runAlternation().find((payload) => payload.uuid !== ORIGINAL_UUID)!

    expect(copy.duplicate_of).toEqual(ORIGINAL_UUID)
    // Nothing diverged here — the item was re-identified, not duplicated — so the
    // conflict marker is deliberately absent. Setting it would badge every note of a
    // backup import as a conflicted copy and drop them from the user's note count.
    expect((copy as DecryptedPayload).content.conflict_of).toBeUndefined()
  })

  it('STEP 4 — consequently the copy stays in the ordinary list and out of the Conflicts view', () => {
    const notes = asNotes(runAlternation())
    const copyUuid = notes.find((note) => note.uuid !== ORIGINAL_UUID)!.uuid

    // Correct: it IS the note, not a conflicted copy of one.
    expect(listFor(SystemViewId.AllNotes, notes)).toContain(copyUuid)
    expect(listFor(SystemViewId.Conflicts, notes)).toEqual([])
  })

  it('OPEN LINK — an editor holding the old uuid can only follow this item via duplicate_of', () => {
    const results = runAlternation()
    const copy = results.find((payload) => payload.uuid !== ORIGINAL_UUID)!

    // A rescue scan keyed on `conflict_of === <old uuid>` finds nothing here, which is
    // why the editor migration has to match `duplicate_of` to follow the item to its
    // new identity. Pinned so the contract is visible if either side changes.
    const byConflictOf = results.filter(
      (payload) => isDecryptedPayload(payload) && payload.content.conflict_of === ORIGINAL_UUID,
    )
    expect(byConflictOf).toHaveLength(0)

    const byDuplicateOf = results.filter((payload) => payload.duplicate_of === ORIGINAL_UUID)
    expect(byDuplicateOf).toEqual([copy])
  })
})

import { CreateItemDelta } from './../Index/ItemDelta'
import { DeletedPayload } from './../../Abstract/Payload/Implementations/DeletedPayload'
import { createFile, createNote, createTagWithTitle, mockUuid, pinnedContent } from './../../Utilities/Test/SpecUtils'
import { ContentType } from '@standardnotes/domain-core'
import { DeletedItem, EncryptedItem } from '../../Abstract/Item'
import { EncryptedPayload, PayloadTimestampDefaults } from '../../Abstract/Payload'
import { createNoteWithContent } from '../../Utilities/Test/SpecUtils'
import { ItemCollection } from './../Collection/Item/ItemCollection'
import { ItemDisplayController } from './ItemDisplayController'
import { SNNote } from '../../Syncable/Note'

describe('item display controller', () => {
  it('should sort items', () => {
    const collection = new ItemCollection()
    const noteA = createNoteWithContent({ title: 'a' })
    const noteB = createNoteWithContent({ title: 'b' })
    collection.set([noteA, noteB])

    const controller = new ItemDisplayController(collection, [ContentType.TYPES.Note], {
      sortBy: 'title',
      sortDirection: 'asc',
    })

    expect(controller.items()[0]).toEqual(noteA)
    expect(controller.items()[1]).toEqual(noteB)

    controller.setDisplayOptions({ sortBy: 'title', sortDirection: 'dsc' })

    expect(controller.items()[0]).toEqual(noteB)
    expect(controller.items()[1]).toEqual(noteA)
  })

  it('should filter items', () => {
    const collection = new ItemCollection()
    const noteA = createNoteWithContent({ title: 'a' })
    const noteB = createNoteWithContent({ title: 'b' })
    collection.set([noteA, noteB])

    const controller = new ItemDisplayController(collection, [ContentType.TYPES.Note], {
      sortBy: 'title',
      sortDirection: 'asc',
    })

    controller.setDisplayOptions({
      customFilter: (note) => {
        return note.title !== 'a'
      },
    })

    expect(controller.items()).toHaveLength(1)
    expect(controller.items()[0].title).toEqual('b')
  })

  it('should resort items after collection change', () => {
    const collection = new ItemCollection()
    const noteA = createNoteWithContent({ title: 'a' })
    collection.set([noteA])

    const controller = new ItemDisplayController(collection, [ContentType.TYPES.Note], {
      sortBy: 'title',
      sortDirection: 'asc',
    })
    expect(controller.items()).toHaveLength(1)

    const noteB = createNoteWithContent({ title: 'b' })

    const delta = CreateItemDelta({ changed: [noteB] })
    collection.onChange(delta)
    controller.onCollectionChange(delta)

    expect(controller.items()).toHaveLength(2)
  })

  it('should not display encrypted items', () => {
    const collection = new ItemCollection()
    const noteA = new EncryptedItem(
      new EncryptedPayload({
        uuid: mockUuid(),
        content_type: ContentType.TYPES.Note,
        content: '004:...',
        enc_item_key: '004:...',
        items_key_id: mockUuid(),
        errorDecrypting: true,
        waitingForKey: false,
        ...PayloadTimestampDefaults(),
      }),
    )
    collection.set([noteA])

    const controller = new ItemDisplayController(collection, [ContentType.TYPES.Note], {
      sortBy: 'title',
      sortDirection: 'asc',
    })

    expect(controller.items()).toHaveLength(0)
  })

  it('pinned items should come first', () => {
    const collection = new ItemCollection()
    const noteA = createNoteWithContent({ title: 'a' })
    const noteB = createNoteWithContent({ title: 'b' })
    collection.set([noteA, noteB])

    const controller = new ItemDisplayController(collection, [ContentType.TYPES.Note], {
      sortBy: 'title',
      sortDirection: 'asc',
    })

    expect(controller.items()[0]).toEqual(noteA)
    expect(controller.items()[1]).toEqual(noteB)

    expect(collection.all()).toHaveLength(2)

    const pinnedNoteB = new SNNote(
      noteB.payload.copy({
        content: {
          ...noteB.content,
          ...pinnedContent(),
        },
      }),
    )
    expect(pinnedNoteB.pinned).toBeTruthy()

    const delta = CreateItemDelta({ changed: [pinnedNoteB] })
    collection.onChange(delta)
    controller.onCollectionChange(delta)

    expect(controller.items()[0]).toEqual(pinnedNoteB)
    expect(controller.items()[1]).toEqual(noteA)
  })

  it('should not display deleted items', () => {
    const collection = new ItemCollection()
    const noteA = createNoteWithContent({ title: 'a' })
    collection.set([noteA])

    const controller = new ItemDisplayController(collection, [ContentType.TYPES.Note], {
      sortBy: 'title',
      sortDirection: 'asc',
    })

    const deletedItem = new DeletedItem(
      new DeletedPayload({
        ...noteA.payload,
        content: undefined,
        deleted: true,
      }),
    )

    const delta = CreateItemDelta({ changed: [deletedItem] })
    collection.onChange(delta)
    controller.onCollectionChange(delta)

    expect(controller.items()).toHaveLength(0)
  })

  it('discarding elements should remove from display', () => {
    const collection = new ItemCollection()
    const noteA = createNoteWithContent({ title: 'a' })
    collection.set([noteA])

    const controller = new ItemDisplayController(collection, [ContentType.TYPES.Note], {
      sortBy: 'title',
      sortDirection: 'asc',
    })

    const delta = CreateItemDelta({ discarded: [noteA] as unknown as DeletedItem[] })
    collection.onChange(delta)
    controller.onCollectionChange(delta)

    expect(controller.items()).toHaveLength(0)
  })

  it('should ignore items not matching content type on construction', () => {
    const collection = new ItemCollection()
    const note = createNoteWithContent({ title: 'a' })
    const tag = createTagWithTitle()
    collection.set([note, tag])

    const controller = new ItemDisplayController(collection, [ContentType.TYPES.Note], {
      sortBy: 'title',
      sortDirection: 'asc',
    })
    expect(controller.items()).toHaveLength(1)
  })

  it('should ignore items not matching content type on sort change', () => {
    const collection = new ItemCollection()
    const note = createNoteWithContent({ title: 'a' })
    const tag = createTagWithTitle()
    collection.set([note, tag])

    const controller = new ItemDisplayController(collection, [ContentType.TYPES.Note], {
      sortBy: 'title',
      sortDirection: 'asc',
    })
    controller.setDisplayOptions({ sortBy: 'created_at', sortDirection: 'asc' })
    expect(controller.items()).toHaveLength(1)
  })

  it('should ignore collection deltas with items not matching content types', () => {
    const collection = new ItemCollection()
    const note = createNoteWithContent({ title: 'a' })
    collection.set([note])

    const controller = new ItemDisplayController(collection, [ContentType.TYPES.Note], {
      sortBy: 'title',
      sortDirection: 'asc',
    })
    const tag = createTagWithTitle()

    const delta = CreateItemDelta({ inserted: [tag], changed: [note] })
    collection.onChange(delta)
    controller.onCollectionChange(delta)

    expect(controller.items()).toHaveLength(1)
  })

  it('should display compound item types', () => {
    const collection = new ItemCollection()
    const note = createNoteWithContent({ title: 'Z' })
    const file = createFile('A')
    collection.set([note, file])

    const controller = new ItemDisplayController(collection, [ContentType.TYPES.Note, ContentType.TYPES.File], {
      sortBy: 'title',
      sortDirection: 'asc',
    })

    expect(controller.items()[0]).toEqual(file)
    expect(controller.items()[1]).toEqual(note)

    controller.setDisplayOptions({ sortBy: 'title', sortDirection: 'dsc' })

    expect(controller.items()[0]).toEqual(note)
    expect(controller.items()[1]).toEqual(file)
  })

  it('deferred (batched cold-load) sort produces the same final order as a single sort', () => {
    // Build a deterministic set of notes whose titles are NOT in sorted order, so a
    // wrong/missing final sort would be detectable.
    const titles = ['m', 'c', 'z', 'a', 'q', 'b', 'y', 'd', 'x', 'e', 'n', 'f']
    const makeNotes = () => titles.map((title) => createNoteWithContent({ title }))

    // Baseline: emit every note in ONE delta with the normal (non-deferred) path.
    const baselineCollection = new ItemCollection()
    const baselineNotes = makeNotes()
    const baselineController = new ItemDisplayController(baselineCollection, [ContentType.TYPES.Note], {
      sortBy: 'title',
      sortDirection: 'asc',
    })
    const baselineDelta = CreateItemDelta({ inserted: baselineNotes })
    baselineCollection.onChange(baselineDelta)
    baselineController.onCollectionChange(baselineDelta)
    const baselineOrder = baselineController.items().map((note) => note.title)

    // Deferred: emit the SAME notes split across several batches with deferSort=true,
    // mimicking the incremental cold-load. No resort happens between batches.
    const deferredCollection = new ItemCollection()
    const deferredNotes = makeNotes()
    const deferredController = new ItemDisplayController(deferredCollection, [ContentType.TYPES.Note], {
      sortBy: 'title',
      sortDirection: 'asc',
    })

    const batchSize = 3
    for (let i = 0; i < deferredNotes.length; i += batchSize) {
      const batch = deferredNotes.slice(i, i + batchSize)
      const delta = CreateItemDelta({ inserted: batch })
      deferredCollection.onChange(delta)
      deferredController.onCollectionChange(delta, true /* deferSort */)
    }

    // The lazy sort happens on first items() read; the final order must match the
    // single-sort baseline exactly (proving deferral changes nothing but timing).
    const deferredOrder = deferredController.items().map((note) => note.title)

    expect(deferredOrder).toEqual(baselineOrder)
    expect(deferredOrder).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'm', 'n', 'q', 'x', 'y', 'z'])
    expect(deferredController.items()).toHaveLength(titles.length)
  })

  it('deferred batched load with a re-emit of the same uuid does not duplicate the item', () => {
    const collection = new ItemCollection()
    const controller = new ItemDisplayController(collection, [ContentType.TYPES.Note], {
      sortBy: 'title',
      sortDirection: 'asc',
    })

    const noteA = createNoteWithContent({ title: 'a' })
    const noteB = createNoteWithContent({ title: 'b' })

    const firstBatch = CreateItemDelta({ inserted: [noteA, noteB] })
    collection.onChange(firstBatch)
    controller.onCollectionChange(firstBatch, true)

    // A later batch re-emits noteA (same uuid) before any resort flush; it must replace
    // in place rather than push a duplicate.
    const updatedNoteA = new SNNote(noteA.payload.copy())
    const secondBatch = CreateItemDelta({ changed: [updatedNoteA] })
    collection.onChange(secondBatch)
    controller.onCollectionChange(secondBatch, true)

    expect(controller.items()).toHaveLength(2)
    expect(controller.items().map((n) => n.title)).toEqual(['a', 'b'])
  })

  it('should hide hidden types', () => {
    const collection = new ItemCollection()
    const note = createNote()
    const file = createFile()
    collection.set([note, file])

    const controller = new ItemDisplayController(collection, [ContentType.TYPES.Note, ContentType.TYPES.File], {
      sortBy: 'title',
      sortDirection: 'asc',
    })

    expect(controller.items()).toHaveLength(2)

    controller.setDisplayOptions({ hiddenContentTypes: [ContentType.TYPES.File] })

    expect(controller.items()).toHaveLength(1)
  })
})

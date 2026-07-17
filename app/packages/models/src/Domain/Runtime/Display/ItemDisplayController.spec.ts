import { CreateItemDelta } from './../Index/ItemDelta'
import { DeletedPayload } from './../../Abstract/Payload/Implementations/DeletedPayload'
import { createFile, createNote, createTagWithTitle, mockUuid, pinnedContent } from './../../Utilities/Test/SpecUtils'
import { ContentType } from '@standardnotes/domain-core'
import { DeletedItem, EncryptedItem } from '../../Abstract/Item'
import { EncryptedPayload, PayloadTimestampDefaults } from '../../Abstract/Payload'
import { createNoteWithContent } from '../../Utilities/Test/SpecUtils'
import { ItemCollection } from './../Collection/Item/ItemCollection'
import { ItemDisplayController } from './ItemDisplayController'
import { NoteContent, SNNote } from '../../Syncable/Note'
import { CollectionSortDirection, CollectionSortProperty } from '../Collection/CollectionSort'
import * as SortTwoItemsModule from './SortTwoItems'

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

  /**
   * Standard Red Notes (cold-load throughput fix): the incremental merge resort
   * (sort only the appended tail, merge into the already-sorted region) MUST produce
   * output element-for-element identical to the legacy full resort, for every sort
   * mode/direction the notes list uses, including pinned-first, ties, in-place
   * changes and removals. These randomized scenarios run the SAME delta sequence
   * through two controllers — one allowed to merge incrementally, one forced down
   * the legacy full-sort path before every read — and require identical output at
   * every read.
   */
  describe('incremental resort equivalence (randomized)', () => {
    const AppDomain = 'org.standardnotes.sn'

    /** Deterministic PRNG (mulberry32) so failures are reproducible by seed. */
    const makeRandom = (seed: number) => {
      let state = seed >>> 0
      return () => {
        state = (state + 0x6d2b79f5) >>> 0
        let t = state
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
    }

    /** Short titles from a tiny alphabet (plus occasional empty) so ties are frequent. */
    const randomTitle = (rand: () => number): string => {
      const letters = 'abcdef'
      const length = Math.floor(rand() * 3)
      let title = ''
      for (let i = 0; i < length; i++) {
        title += letters[Math.floor(rand() * letters.length)]
      }
      return title
    }

    /** Dates drawn from a small pool of distinct days so date ties are frequent too. */
    const randomDate = (rand: () => number): Date => {
      return new Date(1600000000000 + Math.floor(rand() * 20) * 86400000)
    }

    const createRandomNote = (rand: () => number): SNNote => {
      return createNoteWithContent(
        {
          title: randomTitle(rand),
          appData: {
            [AppDomain]: {
              client_updated_at: randomDate(rand),
              pinned: rand() < 0.15,
            },
          },
        },
        randomDate(rand),
      )
    }

    /** Re-emit a note with a randomly mutated sort-relevant field (or unchanged). */
    const mutateNote = (note: SNNote, rand: () => number): SNNote => {
      const choice = rand()
      if (choice < 0.25) {
        return new SNNote(
          note.payload.copy({
            content: { ...note.payload.content, title: randomTitle(rand) } as NoteContent,
          }),
        )
      } else if (choice < 0.5) {
        return new SNNote(note.payload.copy({ created_at: randomDate(rand) }))
      } else if (choice < 0.75) {
        return new SNNote(
          note.payload.copy({
            content: {
              ...note.payload.content,
              appData: {
                ...note.payload.content.appData,
                [AppDomain]: {
                  ...note.payload.content.appData?.[AppDomain],
                  client_updated_at: randomDate(rand),
                  pinned: rand() < 0.5,
                },
              },
            },
          }),
        )
      }
      /** Re-emit with no sort-relevant change (exercises the equal-value replace branch). */
      return new SNNote(note.payload.copy())
    }

    const forceLegacyFullResort = (controller: ItemDisplayController<SNNote>) => {
      ;(controller as unknown as { needsFullResort: boolean }).needsFullResort = true
    }

    const runScenario = (sortBy: CollectionSortProperty, sortDirection: CollectionSortDirection, seed: number) => {
      const rand = makeRandom(seed)

      const incrementalCollection = new ItemCollection()
      const referenceCollection = new ItemCollection()
      const incremental = new ItemDisplayController<SNNote>(incrementalCollection, [ContentType.TYPES.Note], {
        sortBy,
        sortDirection,
      })
      const reference = new ItemDisplayController<SNNote>(referenceCollection, [ContentType.TYPES.Note], {
        sortBy,
        sortDirection,
      })

      const live: SNNote[] = []

      const applyDelta = (inserted: SNNote[], changed: SNNote[], discarded: SNNote[]) => {
        const delta = CreateItemDelta({
          inserted,
          changed,
          discarded: discarded as unknown as DeletedItem[],
        })
        incrementalCollection.onChange(delta)
        incremental.onCollectionChange(delta, true /* deferSort, as during cold load */)
        referenceCollection.onChange(delta)
        reference.onCollectionChange(delta, true)
      }

      const expectIdenticalOutput = () => {
        forceLegacyFullResort(reference)
        const incrementalOrder = incremental.items().map((note) => note.uuid)
        const referenceOrder = reference.items().map((note) => note.uuid)
        expect(incrementalOrder).toEqual(referenceOrder)
        expect(incrementalOrder).toHaveLength(live.length)
      }

      const totalBatches = 14
      for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
        const inserted: SNNote[] = []
        const insertCount = 1 + Math.floor(rand() * 25)
        for (let i = 0; i < insertCount; i++) {
          inserted.push(createRandomNote(rand))
        }

        /** After the first few pure-insert batches, mix in in-place changes + removals. */
        const changed: SNNote[] = []
        const discarded: SNNote[] = []
        if (batchIndex >= 3 && live.length > 4) {
          const usedIndexes = new Set<number>()
          const changeCount = Math.floor(rand() * 3)
          for (let i = 0; i < changeCount; i++) {
            const index = Math.floor(rand() * live.length)
            if (usedIndexes.has(index)) {
              continue
            }
            usedIndexes.add(index)
            const mutated = mutateNote(live[index], rand)
            live[index] = mutated
            changed.push(mutated)
          }
          const removeCount = Math.floor(rand() * 2)
          for (let i = 0; i < removeCount; i++) {
            const index = Math.floor(rand() * live.length)
            if (usedIndexes.has(index)) {
              continue
            }
            discarded.push(live[index])
            live.splice(index, 1)
          }
        }

        live.push(...inserted)
        applyDelta(inserted, changed, discarded)

        /**
         * Read only on some batches so multiple deferred batches accumulate between
         * reads (as with the real ~1/s throttle), and duplicates/removals can hit the
         * not-yet-sorted tail.
         */
        if (batchIndex % 3 === 2) {
          expectIdenticalOutput()
        }
      }

      /** A removal-only batch (compaction-only merge). */
      if (live.length > 2) {
        const removed = live.splice(Math.floor(rand() * live.length), 1)
        applyDelta([], [], removed)
      }

      expectIdenticalOutput()
    }

    const sortModes: [CollectionSortProperty, CollectionSortDirection][] = [
      ['title', 'asc'],
      ['title', 'dsc'],
      ['created_at', 'asc'],
      ['created_at', 'dsc'],
      ['userModifiedDate', 'asc'],
      ['userModifiedDate', 'dsc'],
    ]

    it.each(sortModes)('incremental merge === full resort for sortBy %s %s (randomized)', (sortBy, sortDirection) => {
      for (let seed = 1; seed <= 5; seed++) {
        runScenario(sortBy, sortDirection, seed)
      }
    })

    it('falls back to the full resort path when display options change mid-load', () => {
      const rand = makeRandom(42)
      const collection = new ItemCollection()
      const controller = new ItemDisplayController<SNNote>(collection, [ContentType.TYPES.Note], {
        sortBy: 'created_at',
        sortDirection: 'dsc',
      })

      /**
       * Titles are UNIQUE here so the fresh reference controller below is a valid
       * ground truth: with ties, the tie-order of a full stable resort legitimately
       * depends on the controller's current array order (legacy behavior), which a
       * fresh controller can't reproduce. Tie behavior is covered by the randomized
       * same-sequence scenarios above.
       */
      const notes: SNNote[] = []
      for (let i = 0; i < 40; i++) {
        const note = createRandomNote(rand)
        notes.push(
          new SNNote(
            note.payload.copy({
              content: {
                ...note.payload.content,
                title: `${randomTitle(rand)}-${String(i).padStart(3, '0')}`,
              } as NoteContent,
            }),
          ),
        )
      }
      for (let i = 0; i < notes.length; i += 10) {
        const delta = CreateItemDelta({ inserted: notes.slice(i, i + 10) })
        collection.onChange(delta)
        controller.onCollectionChange(delta, true)
        if (i === 10) {
          void controller.items()
        }
      }

      controller.setDisplayOptions({ sortBy: 'title', sortDirection: 'asc' })

      const referenceCollection = new ItemCollection()
      referenceCollection.set(notes)
      const reference = new ItemDisplayController<SNNote>(referenceCollection, [ContentType.TYPES.Note], {
        sortBy: 'title',
        sortDirection: 'asc',
      })
      forceLegacyFullResort(reference)

      expect(controller.items().map((n) => n.uuid)).toEqual(reference.items().map((n) => n.uuid))
    })
  })

  /**
   * Standard Red Notes (cold-load throughput fix): comparator-call-count proof that the
   * incremental merge does ~O(N + M log M) work per cold-load tick instead of the old
   * O(N log N). Not wall-clock asserted — we count sortTwoItems invocations per read and
   * log them; the only assertion is that the incremental path does strictly less
   * comparator work than the forced full resort at every tick.
   */
  describe('incremental resort comparator-work micro-benchmark', () => {
    it('merge path does far fewer comparator calls per cold-load tick than a full resort', () => {
      const existingCount = 10000
      const batchSize = 1000
      const batchCount = 5

      const makeNote = (index: number) =>
        createNoteWithContent(
          { title: `note-${(index * 2654435761) % 100000}` },
          new Date(1600000000000 + ((index * 48271) % 100000) * 1000),
        )

      const notes: SNNote[] = []
      for (let i = 0; i < existingCount + batchSize * batchCount; i++) {
        notes.push(makeNote(i))
      }

      const collection = new ItemCollection()
      const incremental = new ItemDisplayController<SNNote>(collection, [ContentType.TYPES.Note], {
        sortBy: 'created_at',
        sortDirection: 'dsc',
      })
      const full = new ItemDisplayController<SNNote>(collection, [ContentType.TYPES.Note], {
        sortBy: 'created_at',
        sortDirection: 'dsc',
      })

      const initialDelta = CreateItemDelta({ inserted: notes.slice(0, existingCount) })
      collection.onChange(initialDelta)
      incremental.onCollectionChange(initialDelta, true)
      full.onCollectionChange(initialDelta, true)
      void incremental.items()
      void full.items()

      const spy = jest.spyOn(SortTwoItemsModule, 'sortTwoItems')

      const rows: { tick: number; total: number; incrementalCalls: number; fullResortCalls: number }[] = []

      for (let batch = 0; batch < batchCount; batch++) {
        const start = existingCount + batch * batchSize
        const delta = CreateItemDelta({ inserted: notes.slice(start, start + batchSize) })
        collection.onChange(delta)
        incremental.onCollectionChange(delta, true)
        full.onCollectionChange(delta, true)

        spy.mockClear()
        void incremental.items()
        const incrementalCalls = spy.mock.calls.length

        ;(full as unknown as { needsFullResort: boolean }).needsFullResort = true
        spy.mockClear()
        void full.items()
        const fullResortCalls = spy.mock.calls.length

        rows.push({ tick: batch + 1, total: start + batchSize, incrementalCalls, fullResortCalls })
        expect(incrementalCalls).toBeLessThan(fullResortCalls)
      }

      spy.mockRestore()

      // eslint-disable-next-line no-console
      console.log(
        'Cold-load resort comparator calls per tick (N existing + M=1000 batch):\n' +
          rows
            .map(
              (row) =>
                `  tick ${row.tick} (total ${row.total}): incremental merge=${row.incrementalCalls}, full resort=${row.fullResortCalls} (${(
                  row.fullResortCalls / Math.max(row.incrementalCalls, 1)
                ).toFixed(1)}x)`,
            )
            .join('\n'),
      )
    })
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

import { KeepSameOrder, SortLeftFirst, SortRightFirst, sortByCustomOrder, sortTwoItems } from './SortTwoItems'
import { createNoteWithContent } from '../../Utilities/Test/SpecUtils'
import { SNNote } from '../../Syncable/Note'
import { CustomSortKey } from '../Collection/CollectionSort'

describe('sort two items', () => {
  it('should sort correctly by dates', () => {
    const noteA = createNoteWithContent({}, new Date(0))
    const noteB = createNoteWithContent({}, new Date(1))

    expect(sortTwoItems(noteA, noteB, 'created_at', 'asc')).toEqual(SortLeftFirst)
    expect(sortTwoItems(noteA, noteB, 'created_at', 'dsc')).toEqual(SortRightFirst)
  })

  it('should sort by title', () => {
    const noteA = createNoteWithContent({ title: 'a' })
    const noteB = createNoteWithContent({ title: 'b' })

    expect(sortTwoItems(noteA, noteB, 'title', 'asc')).toEqual(SortLeftFirst)
    expect(sortTwoItems(noteA, noteB, 'title', 'dsc')).toEqual(SortRightFirst)
  })

  it('should sort correctly by title and pinned', () => {
    const noteA = createNoteWithContent({ title: 'a' })
    const noteB = { ...createNoteWithContent({ title: 'b' }), pinned: true } as jest.Mocked<SNNote>

    expect(sortTwoItems(noteA, noteB, 'title', 'asc')).toEqual(SortRightFirst)
    expect(sortTwoItems(noteA, noteB, 'title', 'dsc')).toEqual(SortRightFirst)
  })
})

describe('custom (manual) order sort', () => {
  it('orders items by their index in the custom order map', () => {
    const noteA = createNoteWithContent({ title: 'a' })
    const noteB = createNoteWithContent({ title: 'b' })
    const orderMap = { [noteA.uuid]: 1, [noteB.uuid]: 0 }

    // noteB has the lower index, so it should come first.
    expect(sortByCustomOrder(noteA, noteB, orderMap)).toEqual(SortRightFirst)
    expect(sortByCustomOrder(noteB, noteA, orderMap)).toEqual(SortLeftFirst)
  })

  it('places items present in the order before items absent from it', () => {
    const ordered = createNoteWithContent({ title: 'a' })
    const newItem = createNoteWithContent({ title: 'b' })
    const orderMap = { [ordered.uuid]: 0 }

    expect(sortByCustomOrder(ordered, newItem, orderMap)).toEqual(SortLeftFirst)
    expect(sortByCustomOrder(newItem, ordered, orderMap)).toEqual(SortRightFirst)
  })

  it('falls back to a stable title sort for items not in the order', () => {
    const noteA = createNoteWithContent({ title: 'a' })
    const noteZ = createNoteWithContent({ title: 'z' })
    const orderMap = {}

    expect(sortByCustomOrder(noteA, noteZ, orderMap)).toEqual(SortLeftFirst)
    expect(sortByCustomOrder(noteZ, noteA, orderMap)).toEqual(SortRightFirst)
  })

  it('returns KeepSameOrder for equal indexes', () => {
    const noteA = createNoteWithContent({ title: 'a' })
    const noteB = createNoteWithContent({ title: 'b' })
    const orderMap = { [noteA.uuid]: 0, [noteB.uuid]: 0 }

    expect(sortByCustomOrder(noteA, noteB, orderMap)).toEqual(KeepSameOrder)
  })

  it('is routed through sortTwoItems when the Custom sort key is active', () => {
    const noteA = createNoteWithContent({ title: 'a' })
    const noteB = createNoteWithContent({ title: 'b' })
    const orderMap = { [noteA.uuid]: 1, [noteB.uuid]: 0 }

    expect(sortTwoItems(noteA, noteB, CustomSortKey, 'asc', false, orderMap)).toEqual(SortRightFirst)
  })

  it('keeps pinned items above the custom order', () => {
    const pinned = { ...createNoteWithContent({ title: 'a' }), pinned: true } as jest.Mocked<SNNote>
    const unpinned = createNoteWithContent({ title: 'b' })
    const orderMap = { [unpinned.uuid]: 0, [pinned.uuid]: 1 }

    // Even though `unpinned` has the lower custom index, `pinned` floats to top.
    expect(sortTwoItems(pinned, unpinned, CustomSortKey, 'asc', false, orderMap)).toEqual(SortLeftFirst)
  })
})

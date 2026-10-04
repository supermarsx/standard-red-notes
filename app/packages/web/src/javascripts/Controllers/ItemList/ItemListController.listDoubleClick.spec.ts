import { ContentType, NoteType, Result, SNNote } from '@standardnotes/snjs'
import { InternalEventBus, ItemManagerInterface } from '@standardnotes/services'
import { ItemGroupController } from '@/Components/NoteView/Controller/ItemGroupController'
import { ItemListController } from './ItemListController'

/**
 * Standard Red Notes: double-clicking a row in the notes list opens that note in
 * a NEW editor tab instead of taking the current one over.
 *
 * A double click is two clicks and the FIRST one already ran the ordinary open,
 * which took the active tab over. So the gesture REPAIRS that takeover rather
 * than withholding the first click (which would tax every single click with a
 * double-click threshold) or closing and re-opening the note (which would churn
 * an editor that is already mounted). These tests therefore drive the real
 * sequence — single-click open, then the double-click handler — and assert the
 * END STATE: both notes open, the displaced one back in its original slot, the
 * double-clicked one active, and never two tabs for one note.
 *
 * The last point is load-bearing: double-clicking a row is exactly what produced
 * an earlier editor-duplication bug (fixed by t99's in-flight open dedupe in
 * ItemGroupController), so a gesture built ON the double click must not
 * reintroduce it.
 */
jest.mock('@standardnotes/toast', () => ({
  addToast: jest.fn(),
  ToastType: { Success: 'success', Error: 'error', Loading: 'loading' },
}))

jest.mock('@/Components/NoteView/Controller/NoteViewController', () => {
  class MockNoteViewController {
    runtimeId = `${Math.random()}`
    item: { uuid: string }
    dealloced = false
    initialize = jest.fn().mockResolvedValue(undefined)
    deinit = jest.fn(() => {
      this.dealloced = true
    })
    deinitImmediatelyForSecurity = jest.fn(() => {
      this.dealloced = true
    })
    syncOnlyIfLargeNote = jest.fn()
    flushAndAwaitPendingSave = jest.fn().mockResolvedValue(undefined)
    flushAndAwaitPendingSaveStrict = jest.fn().mockResolvedValue(undefined)

    constructor(item?: { uuid: string }) {
      this.item = item ?? { uuid: this.runtimeId }
    }
  }
  return { NoteViewController: MockNoteViewController }
})

const makeNote = (uuid: string): SNNote =>
  ({
    uuid,
    title: uuid,
    text: '',
    content_type: ContentType.TYPES.Note,
    noteType: NoteType.Plain,
    created_at: new Date(0),
    protected: false,
    payload: {},
  }) as unknown as SNNote

describe('notes-list double click opens a new tab', () => {
  let controller: ItemListController
  let group: ItemGroupController
  let store: Map<string, SNNote>

  const items = () =>
    ({
      findItem: jest.fn((uuid: string) => store.get(uuid)),
      streamItems: jest.fn(() => jest.fn()),
      getItems: jest.fn(() => [...store.values()]),
      conflictsOf: jest.fn().mockReturnValue([]),
      getDisplayableNotes: jest.fn(() => [...store.values()]),
      getDisplayableFiles: jest.fn(() => []),
      setPrimaryItemDisplayOptions: jest.fn(),
    }) as unknown as ItemManagerInterface

  beforeEach(() => {
    store = new Map([
      ['note-a', makeNote('note-a')],
      ['note-b', makeNote('note-b')],
      ['note-c', makeNote('note-c')],
    ])

    const itemManager = items()
    /**
     * The local-pref store must really STORE: a fake whose `setLocalValue` drops
     * the write makes `setTabLocked` inert, and the locked-tab test below then
     * passes by taking the ordinary takeover path — i.e. it would stop testing
     * the lock at all. (Caught by mutating the repair away: that test failed with
     * the others instead of holding.)
     */
    const localValues = new Map<string, unknown>()
    const preferences = {
      getValue: jest.fn((_key: string, fallback: unknown) => fallback),
      getLocalValue: jest.fn((key: string, fallback: unknown) =>
        localValues.has(key) ? localValues.get(key) : fallback,
      ),
      setLocalValue: jest.fn((key: string, value: unknown) => {
        localValues.set(key, value)
      }),
    }

    group = new ItemGroupController(
      itemManager,
      {} as never,
      {} as never,
      { isSignedIn: jest.fn().mockReturnValue(false), getUser: jest.fn() } as never,
      preferences as never,
      {} as never,
      {} as never,
      (() => false) as never,
    )

    controller = new ItemListController(
      { activeModifiers: new Set(), cancelAllKeyboardModifiers: jest.fn() } as never,
      {
        isInMobileView: false,
        activeViewTab: undefined,
        setPaneLayout: jest.fn(),
        closeViewTab: jest.fn(),
        setActiveViewTab: jest.fn(),
      } as never,
      {
        selected: undefined,
        selectedFolder: undefined,
        selectedUuid: undefined,
        isInAnySystemView: jest.fn(() => false),
        isInSystemView: jest.fn(() => false),
        isInSmartView: jest.fn(() => false),
        isInHomeView: jest.fn(() => false),
      } as never,
      { includeProtectedContents: false, includeArchived: false, includeTrashed: false } as never,
      itemManager,
      {} as never,
      preferences as never,
      group,
      { exclusivelyShownVault: undefined } as never,
      undefined,
      {
        authorizeItemAccess: jest.fn().mockResolvedValue(true),
        authorizeProtectedActionForItems: jest.fn(async (candidates: unknown) => candidates),
      } as never,
      { allowNoteSelectionStatePersistence: true } as never,
      { execute: jest.fn().mockReturnValue(Result.ok(false)) } as never,
      { execute: jest.fn() } as never,
      { add: jest.fn() } as never,
      new InternalEventBus(),
    )
  })

  afterEach(() => {
    controller.deinit()
  })

  const openUuids = () => group.itemControllers.map((open) => open.item?.uuid)
  const activeUuid = () => group.activeItemViewController?.item?.uuid

  /**
   * The real gesture: the first click of the burst records the tab it is about to
   * displace (that is what NoteListItem does), the single-click open runs, and
   * then the double-click handler repairs it.
   */
  const doubleClickRow = async (uuid: string) => {
    const active = group.activeItemViewController
    const activeUuidBefore = active?.item?.uuid
    const displaced =
      active && activeUuidBefore ? { uuid: activeUuidBefore, index: group.itemControllers.indexOf(active) } : undefined

    await controller.openNote(uuid)
    await controller.openListItemInNewTabFromDoubleClick(uuid, displaced)
  }

  it('leaves the previously open note open, in its own slot, with the double-clicked note active', async () => {
    await controller.openNote('note-a')
    expect(openUuids()).toEqual(['note-a'])

    await doubleClickRow('note-b')

    expect(openUuids()).toEqual(['note-a', 'note-b'])
    expect(activeUuid()).toBe('note-b')
  })

  it('restores the displaced note to the index it occupied, not the end of the strip', async () => {
    // Strip: [note-a, note-c] with note-a active and about to be displaced.
    await controller.openNote('note-a')
    await controller.openNoteInNewTile('note-c')
    group.setActiveItemController(group.itemControllers[0])

    await doubleClickRow('note-b')

    expect(openUuids()).toEqual(['note-a', 'note-b', 'note-c'])
    expect(activeUuid()).toBe('note-b')
  })

  it('never opens a second tab for the double-clicked note', async () => {
    await controller.openNote('note-a')

    await doubleClickRow('note-b')
    // A second burst on the same row: the note already has its own tab.
    await doubleClickRow('note-b')

    expect(openUuids()).toEqual(['note-a', 'note-b'])
    expect(openUuids().filter((uuid) => uuid === 'note-b')).toHaveLength(1)
  })

  it('double-clicking the note that is already open changes nothing', async () => {
    await controller.openNote('note-a')

    await doubleClickRow('note-a')

    expect(openUuids()).toEqual(['note-a'])
    expect(activeUuid()).toBe('note-a')
  })

  it('opens just the one tab when nothing was open before the burst', async () => {
    await doubleClickRow('note-b')

    expect(openUuids()).toEqual(['note-b'])
    expect(activeUuid()).toBe('note-b')
  })

  it('adds nothing when the displaced note is still open because its tab was LOCKED', async () => {
    await controller.openNote('note-a')
    group.setTabLocked('note-a', true)

    await doubleClickRow('note-b')

    // The lock already gave note-b a tab of its own; there is no takeover to repair.
    expect(openUuids()).toEqual(['note-a', 'note-b'])
    expect(openUuids().filter((uuid) => uuid === 'note-a')).toHaveLength(1)
    expect(activeUuid()).toBe('note-b')
  })

  it('does not try to restore a displaced note that no longer resolves', async () => {
    await controller.openNote('note-a')
    const displaced = { uuid: 'note-a', index: 0 }
    await controller.openNote('note-b')
    store.delete('note-a')

    await controller.openListItemInNewTabFromDoubleClick('note-b', displaced)

    expect(openUuids()).toEqual(['note-b'])
  })

  it('still opens the note when the first click did not open it at all', async () => {
    // e.g. a protections prompt was declined, so nothing is open and nothing was
    // displaced; the gesture must still honour what it promises.
    await controller.openListItemInNewTabFromDoubleClick('note-b', undefined)

    expect(openUuids()).toEqual(['note-b'])
  })
})

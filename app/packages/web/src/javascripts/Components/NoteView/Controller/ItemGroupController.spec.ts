import {
  AlertService,
  ComponentManagerInterface,
  ItemManagerInterface,
  MutatorClientInterface,
  PreferenceServiceInterface,
  SessionsClientInterface,
  SyncServiceInterface,
} from '@standardnotes/snjs'
import { IsNativeMobileWeb } from '@standardnotes/ui-services'
import { ItemGroupController } from './ItemGroupController'
import { NoteViewController } from './NoteViewController'

/**
 * Replace the real NoteViewController/FileViewController with lightweight stubs so the
 * group's add/activate/switch/close logic can be exercised in isolation (the real
 * controllers do heavy async initialization against many services).
 */
jest.mock('./NoteViewController', () => {
  class MockNoteViewController {
    runtimeId = `${Math.random()}`
    item = { uuid: this.runtimeId }
    initialize = jest.fn().mockResolvedValue(undefined)
    deinit = jest.fn()
    syncOnlyIfLargeNote = jest.fn()
    flushAndAwaitPendingSave = jest.fn().mockResolvedValue(undefined)
  }
  return { NoteViewController: MockNoteViewController }
})

jest.mock('./FileViewController', () => {
  class MockFileViewController {}
  return { FileViewController: MockFileViewController }
})

describe('ItemGroupController tabs/tiles', () => {
  let group: ItemGroupController

  beforeEach(() => {
    group = new ItemGroupController(
      {} as ItemManagerInterface,
      {} as MutatorClientInterface,
      {} as SyncServiceInterface,
      {} as SessionsClientInterface,
      {} as PreferenceServiceInterface,
      {} as ComponentManagerInterface,
      {} as AlertService,
      (() => false) as unknown as IsNativeMobileWeb,
    )
  })

  const addTab = () => group.createItemController({ templateOptions: {}, openInNewTile: true })

  it('adding a tab grows the controller set and makes the new one active', async () => {
    const first = await addTab()
    expect(group.itemControllers).toHaveLength(1)
    expect(group.activeItemViewController).toBe(first)

    const second = await addTab()
    expect(group.itemControllers).toHaveLength(2)
    expect(group.activeItemViewController).toBe(second)

    const third = await addTab()
    expect(group.itemControllers).toHaveLength(3)
    expect(group.activeItemViewController).toBe(third)
  })

  it('switching tabs changes the active controller without closing any', async () => {
    const first = await addTab()
    const second = await addTab()

    expect(group.activeItemViewController).toBe(second)

    group.setActiveItemController(first as NoteViewController)

    expect(group.activeItemViewController).toBe(first)
    expect(group.itemControllers).toHaveLength(2)
  })

  it('opening without openInNewTile replaces the active controller (single-note behavior)', async () => {
    await addTab()
    expect(group.itemControllers).toHaveLength(1)

    const replacement = await group.createItemController({ templateOptions: {} })

    expect(group.itemControllers).toHaveLength(1)
    expect(group.activeItemViewController).toBe(replacement)
  })

  /**
   * Standard Red Notes (last-edit-loss fix — note-switch): switching notes (the
   * non-tile replace path) MUST flush the outgoing editor's pending serialize and
   * await local propagation BEFORE deiniting it, otherwise an edit typed within the
   * ~1s debounce window is dropped when <SuperEditor> later unmounts onto a deinited
   * controller. Assert flushAndAwaitPendingSave is called, and called BEFORE deinit.
   */
  it('note-switch flushes + awaits the outgoing editor save BEFORE deiniting it', async () => {
    const outgoing = (await addTab()) as unknown as {
      flushAndAwaitPendingSave: jest.Mock
      deinit: jest.Mock
    }

    const order: string[] = []
    outgoing.flushAndAwaitPendingSave.mockImplementation(async () => {
      order.push('flush')
    })
    outgoing.deinit.mockImplementation(() => {
      order.push('deinit')
    })

    // Replace the active controller (note-switch / single-note behavior).
    await group.createItemController({ templateOptions: {} })

    expect(outgoing.flushAndAwaitPendingSave).toHaveBeenCalledTimes(1)
    expect(outgoing.deinit).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['flush', 'deinit'])
  })

  it('notifies change observers when a tab is added', async () => {
    const observer = jest.fn()
    group.addActiveControllerChangeObserver(observer)
    observer.mockClear()

    await addTab()

    expect(observer).toHaveBeenCalled()
  })

  it('closing the active tab activates a remaining one', async () => {
    const first = await addTab()
    const second = await addTab()

    group.closeItemController(second as NoteViewController)

    expect(group.itemControllers).toHaveLength(1)
    expect(group.activeItemViewController).toBe(first)
  })

  describe('split/tile state', () => {
    /**
     * The tab bar "Split" control drives the group into a multi-controller state so
     * NoteGroupView's `controllers.length > 1` tiling branch renders the open notes
     * side by side. These tests exercise that underlying group transition.
     */
    it('splitting a single open note into a second tile yields the multi-tile state', async () => {
      const first = await addTab()
      expect(group.itemControllers).toHaveLength(1)

      // Equivalent to the split action opening a second note as a tile.
      const second = await addTab()

      expect(group.itemControllers).toHaveLength(2)
      expect(group.itemControllers).toContain(first)
      expect(group.itemControllers).toContain(second)
      // 2+ open controllers is exactly the condition NoteGroupView tiles on.
      expect(group.itemControllers.length > 1).toBe(true)
    })

    it('returning to single by closing a tile keeps the remaining note open', async () => {
      const first = await addTab()
      const second = await addTab()
      expect(group.itemControllers.length > 1).toBe(true)

      group.closeItemController(second as NoteViewController)

      expect(group.itemControllers).toHaveLength(1)
      expect(group.itemControllers.length > 1).toBe(false)
      expect(group.activeItemViewController).toBe(first)
    })
  })
})

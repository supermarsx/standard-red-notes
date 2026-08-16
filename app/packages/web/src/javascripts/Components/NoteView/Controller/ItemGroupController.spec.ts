import {
  AlertService,
  ComponentManagerInterface,
  ItemManagerInterface,
  MutatorClientInterface,
  NoteType,
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
    item: { uuid: string }
    initialize = jest.fn().mockResolvedValue(undefined)
    deinit = jest.fn()
    deinitImmediatelyForSecurity = jest.fn()
    syncOnlyIfLargeNote = jest.fn()
    flushAndAwaitPendingSave = jest.fn().mockResolvedValue(undefined)
    flushAndAwaitPendingSaveStrict = jest.fn().mockResolvedValue(undefined)

    constructor(item?: { uuid: string }) {
      this.item = item ?? { uuid: this.runtimeId }
    }
  }
  return { NoteViewController: MockNoteViewController }
})

jest.mock('./FileViewController', () => {
  class MockFileViewController {}
  return { FileViewController: MockFileViewController }
})

describe('ItemGroupController tabs/tiles', () => {
  let group: ItemGroupController
  let items: jest.Mocked<ItemManagerInterface>
  let sessions: jest.Mocked<SessionsClientInterface>

  beforeEach(() => {
    items = {
      findItem: jest.fn((uuid: string) => ({ uuid, noteType: NoteType.Super })),
    } as unknown as jest.Mocked<ItemManagerInterface>
    sessions = {
      isSignedIn: jest.fn().mockReturnValue(false),
      getUser: jest.fn(),
    } as unknown as jest.Mocked<SessionsClientInterface>
    group = new ItemGroupController(
      items,
      {} as MutatorClientInterface,
      {} as SyncServiceInterface,
      sessions,
      {} as PreferenceServiceInterface,
      {} as ComponentManagerInterface,
      {} as AlertService,
      (() => false) as unknown as IsNativeMobileWeb,
    )
  })

  const addTab = () => group.createItemController({ templateOptions: {}, openInNewTile: true })
  const superNote = (uuid: string) => ({ uuid, noteType: NoteType.Super }) as never

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

  it('security-sensitive close scrubs immediately without syncing retained plaintext', async () => {
    const controller = (await addTab()) as unknown as {
      deinit: jest.Mock
      deinitImmediatelyForSecurity: jest.Mock
      syncOnlyIfLargeNote: jest.Mock
    }
    const observer = jest.fn()
    group.addActiveControllerChangeObserver(observer)
    observer.mockClear()

    group.closeItemController(controller as unknown as NoteViewController, { securitySensitive: true })

    expect(controller.syncOnlyIfLargeNote).not.toHaveBeenCalled()
    expect(controller.deinit).not.toHaveBeenCalled()
    expect(controller.deinitImmediatelyForSecurity).toHaveBeenCalledTimes(1)
    expect(group.itemControllers).not.toContain(controller)
    expect(group.activeItemViewController).toBeUndefined()
    expect(observer).toHaveBeenCalledWith(undefined)
  })

  it('keeps a detached Todo owner out of visible controllers and active selection', async () => {
    const visible = await addTab()
    const detached = await group.createDetachedNoteController(superNote('background-note'))

    expect(group.itemControllers).toEqual([visible])
    expect(group.activeItemViewController).toBe(visible)
    expect(detached.item.uuid).toBe('background-note')

    await group.flushAndCloseDetachedNoteController(detached)
    expect(detached.flushAndAwaitPendingSaveStrict).toHaveBeenCalledTimes(1)
    expect(detached.deinit).toHaveBeenCalledTimes(1)
    expect(group.itemControllers).toEqual([visible])
    expect(group.activeItemViewController).toBe(visible)
  })

  it('keeps source-note authorization across a same-account User object replacement', async () => {
    let currentUser = { uuid: 'same-account' }
    sessions.isSignedIn.mockReturnValue(true)
    sessions.getUser.mockImplementation(() => currentUser as never)

    const opening = group.createDetachedNoteController(superNote('background-note'))
    currentUser = { uuid: 'same-account' }

    await expect(opening).resolves.toBeInstanceOf(NoteViewController)
  })

  it('rejects source-note ownership when the account UUID actually changes', async () => {
    let currentUser = { uuid: 'first-account' }
    sessions.isSignedIn.mockReturnValue(true)
    sessions.getUser.mockImplementation(() => currentUser as never)

    const opening = group.createDetachedNoteController(superNote('background-note'))
    currentUser = { uuid: 'different-account' }

    await expect(opening).rejects.toThrow('ownership changed')
  })

  it('rejects source-note ownership when the session signs out while loading', async () => {
    sessions.isSignedIn.mockReturnValue(true)
    sessions.getUser.mockReturnValue({ uuid: 'signed-in-account' } as never)

    const opening = group.createDetachedNoteController(superNote('background-note'))
    sessions.isSignedIn.mockReturnValue(false)

    await expect(opening).rejects.toThrow('ownership changed')
  })

  it('retains a detached owner when strict local/provider durability fails', async () => {
    const detached = await group.createDetachedNoteController(superNote('background-note'))
    ;(detached.flushAndAwaitPendingSaveStrict as jest.Mock).mockRejectedValueOnce(new Error('local persistence failed'))

    await expect(group.flushAndCloseDetachedNoteController(detached)).rejects.toThrow('local persistence failed')
    expect(detached.deinit).not.toHaveBeenCalled()
    expect(detached.deinitImmediatelyForSecurity).not.toHaveBeenCalled()

    group.closeDetachedNoteControllerImmediately(detached)
    expect(detached.deinitImmediatelyForSecurity).toHaveBeenCalledTimes(1)
  })

  it('reserves a preparing visible Super editor before a detached owner can race it', async () => {
    const note = superNote('same-note')
    const visible = group.createItemController({ note, openInNewTile: true })

    await expect(group.createDetachedNoteController(note)).rejects.toThrow('already open')
    await expect(visible).resolves.toBeInstanceOf(NoteViewController)
  })

  it('strictly releases a detached owner before opening the same note visibly', async () => {
    const note = superNote('same-note')
    const closed = jest.fn()
    const detached = await group.createDetachedNoteController(note, () => closed)
    let finishFlush!: () => void
    ;(detached.flushAndAwaitPendingSaveStrict as jest.Mock).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishFlush = resolve
        }),
    )

    let visibleOpened = false
    const visible = group.createItemController({ note, openInNewTile: true }).then((controller) => {
      visibleOpened = true
      return controller
    })
    await Promise.resolve()
    expect(detached.flushAndAwaitPendingSaveStrict).toHaveBeenCalledTimes(1)
    expect(visibleOpened).toBe(false)

    finishFlush()
    await expect(visible).resolves.toBeInstanceOf(NoteViewController)
    expect(closed).toHaveBeenCalledTimes(1)
    expect(detached.deinit).toHaveBeenCalledTimes(1)
  })

  it('keeps the prior visible UI active when detached strict release fails', async () => {
    const prior = await addTab()
    const note = superNote('blocked-note')
    const detached = await group.createDetachedNoteController(note)
    ;(detached.flushAndAwaitPendingSaveStrict as jest.Mock).mockRejectedValueOnce(new Error('disk unavailable'))

    await expect(group.createItemController({ note })).rejects.toThrow('source note was not opened')
    expect(group.activeItemViewController).toBe(prior)
    expect(group.itemControllers).toEqual([prior])
    expect(detached.deinit).not.toHaveBeenCalled()
  })

  it('cancels a visible-note reservation during the awaited outgoing flush without switching UI', async () => {
    const outgoing = (await addTab()) as unknown as {
      flushAndAwaitPendingSave: jest.Mock
      deinit: jest.Mock
    }
    let finishFlush!: () => void
    outgoing.flushAndAwaitPendingSave.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishFlush = resolve
        }),
    )
    const observer = jest.fn()
    group.addActiveControllerChangeObserver(observer)
    observer.mockClear()
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)

    const opening = group.createItemController({ note: superNote('must-not-open') })
    await Promise.resolve()
    await Promise.resolve()
    expect(outgoing.flushAndAwaitPendingSave).toHaveBeenCalledTimes(1)

    group.cancelChecklistEditorReservationsForSecurity()
    finishFlush()

    await expect(opening).rejects.toThrow('authorization changed')
    expect(outgoing.deinit).not.toHaveBeenCalled()
    expect(group.itemControllers).toEqual([outgoing])
    expect(group.activeItemViewController).toBe(outgoing)
    expect(observer).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('runs each detached close callback exactly once across replacement lifetimes', async () => {
    const note = superNote('same-note')
    const firstClosed = jest.fn()
    const first = await group.createDetachedNoteController(note, () => firstClosed)
    group.closeDetachedNoteControllerImmediately(first)
    group.closeDetachedNoteControllerImmediately(first)
    expect(firstClosed).toHaveBeenCalledTimes(1)

    const secondClosed = jest.fn()
    const second = await group.createDetachedNoteController(note, () => secondClosed)
    expect(firstClosed).toHaveBeenCalledTimes(1)
    expect(secondClosed).not.toHaveBeenCalled()
    group.closeDetachedNoteControllerImmediately(second)
    expect(secondClosed).toHaveBeenCalledTimes(1)
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

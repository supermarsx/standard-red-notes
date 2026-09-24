import {
  AlertService,
  ComponentManagerInterface,
  ContentType,
  DecryptedPayload,
  DeletedPayload,
  FillItemContent,
  InternalEventBusInterface,
  ItemManager,
  ItemManagerInterface,
  LoggerInterface,
  MutatorClientInterface,
  NoteContent,
  NoteType,
  PayloadEmitSource,
  PayloadManager,
  PayloadTimestampDefaults,
  PreferenceServiceInterface,
  SessionsClientInterface,
  SyncServiceInterface,
} from '@standardnotes/snjs'
import { IsNativeMobileWeb } from '@standardnotes/ui-services'
import { ChecklistEditorOpeningCanceledError, ItemGroupController } from './ItemGroupController'
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
  let emitRemoved: (removed: { uuid: string }[]) => void

  beforeEach(() => {
    items = {
      findItem: jest.fn((uuid: string) => ({ uuid, noteType: NoteType.Super })),
      streamItems: jest.fn((_contentType: unknown, stream: (data: { removed: { uuid: string }[] }) => void) => {
        emitRemoved = (removed) => stream({ removed })
        return jest.fn()
      }),
      // Standard Red Notes (t97): the rescue-copy lookup scans content.conflictOf
      // directly (ItemManager.conflictsOf is unusable here -- see the comment on
      // findConflictRescueCopy in ItemGroupController.ts), so the mock surface is
      // getItems, not conflictsOf. conflictsOf is still stubbed (always empty) so
      // that a false-green mutation reverting to the broken API fails cleanly
      // (falls back to "no copy found") instead of throwing.
      getItems: jest.fn().mockReturnValue([]),
      conflictsOf: jest.fn().mockReturnValue([]),
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

  it('keeps an in-flight visible Super editor authorized across an unrelated note revocation', async () => {
    const opening = group.createItemController({ note: superNote('opening-note'), openInNewTile: true })

    group.cancelChecklistEditorReservationsForSecurity('unrelated-note')

    const controller = await opening
    expect(controller).toBeInstanceOf(NoteViewController)
    expect(group.itemControllers).toEqual([controller])
    expect(group.activeItemViewController).toBe(controller)
  })

  it('still rejects an in-flight visible Super editor when that exact note is revoked', async () => {
    const opening = group.createItemController({ note: superNote('revoked-note'), openInNewTile: true })

    group.cancelChecklistEditorReservationsForSecurity('revoked-note')

    await expect(opening).rejects.toBeInstanceOf(ChecklistEditorOpeningCanceledError)
    expect(group.itemControllers).toEqual([])
    expect(group.activeItemViewController).toBeUndefined()
  })

  it('keeps an in-flight detached owner authorized across an unrelated note revocation', async () => {
    const opening = group.createDetachedNoteController(superNote('opening-note'))

    group.cancelChecklistEditorReservationsForSecurity('unrelated-note')

    await expect(opening).resolves.toBeInstanceOf(NoteViewController)
  })

  it('still rejects an in-flight detached owner when that exact note is revoked', async () => {
    const opening = group.createDetachedNoteController(superNote('revoked-note'))

    group.cancelChecklistEditorReservationsForSecurity('revoked-note')

    await expect(opening).rejects.toThrow('ownership changed')
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

  it('preserves typed security cancellation while awaiting a detached-owner release', async () => {
    const note = superNote('revoked-note')
    const detached = await group.createDetachedNoteController(note)
    let finishFlush!: () => void
    ;(detached.flushAndAwaitPendingSaveStrict as jest.Mock).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishFlush = resolve
        }),
    )

    const opening = group.createItemController({ note, openInNewTile: true })
    await Promise.resolve()
    expect(detached.flushAndAwaitPendingSaveStrict).toHaveBeenCalledTimes(1)

    group.cancelChecklistEditorReservationsForSecurity('revoked-note')
    finishFlush()

    await expect(opening).rejects.toBeInstanceOf(ChecklistEditorOpeningCanceledError)
    expect(group.itemControllers).toEqual([])
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
    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('still logs and propagates a real outgoing-editor durability failure', async () => {
    const outgoing = (await addTab()) as unknown as {
      flushAndAwaitPendingSave: jest.Mock
      deinit: jest.Mock
    }
    const failure = new Error('local persistence failed')
    outgoing.flushAndAwaitPendingSave.mockRejectedValueOnce(failure)
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(group.createItemController({ templateOptions: {} })).rejects.toBe(failure)
    expect(consoleError).toHaveBeenCalledWith(failure)
    expect(outgoing.deinit).not.toHaveBeenCalled()
    expect(group.itemControllers).toEqual([outgoing])
    expect(group.activeItemViewController).toBe(outgoing)
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

  /**
   * Standard Red Notes (t97): a note/file can be removed from the local item store while
   * open in a tile (a remote delete, or a conflict resolution that discards this uuid in
   * favor of a duplicate) with nothing previously reacting to it. These exercise the
   * itemManager.streamItems `removed` hook that closes/migrates the affected tile.
   */
  describe('reacting to an open item being removed from the store', () => {
    it('closes the open tile when the removed item has no conflict_of rescue copy', async () => {
      const controller = (await addTab()) as unknown as {
        item: { uuid: string }
        deinitImmediatelyForSecurity: jest.Mock
      }
      const observer = jest.fn()
      group.addActiveControllerChangeObserver(observer)
      observer.mockClear()

      emitRemoved([{ uuid: controller.item.uuid }])
      await Promise.resolve()
      await Promise.resolve()

      expect(items.getItems).toHaveBeenCalled()
      expect(controller.deinitImmediatelyForSecurity).toHaveBeenCalledTimes(1)
      expect(group.itemControllers).not.toContain(controller)
      expect(group.activeItemViewController).toBeUndefined()
      expect(observer).toHaveBeenCalledWith(undefined)
    })

    it('migrates the open tile to its conflict_of rescue copy instead of closing', async () => {
      const controller = (await addTab()) as unknown as {
        item: { uuid: string }
        deinitImmediatelyForSecurity: jest.Mock
      }
      const removedUuid = controller.item.uuid
      const rescueCopy = {
        uuid: 'rescue-copy-uuid',
        content_type: 'Note',
        conflictOf: removedUuid,
        serverUpdatedAtTimestamp: 5,
      }
      items.getItems.mockReturnValue([rescueCopy] as never)

      emitRemoved([{ uuid: removedUuid }])
      await Promise.resolve()
      await Promise.resolve()

      expect(controller.deinitImmediatelyForSecurity).toHaveBeenCalledTimes(1)
      expect(group.itemControllers).toHaveLength(1)
      expect(group.itemControllers).not.toContain(controller)
      expect(group.activeItemViewController?.item.uuid).toBe('rescue-copy-uuid')
    })

    /**
     * Standard Red Notes (t97): PayloadsByAlternatingUuid (a uuid collision on import,
     * e.g. an old backup whose uuids clash with the account's own) re-identifies an item
     * under a new uuid WITHOUT going through PayloadsByDuplicating -- it inlines its own
     * copy and sets ONLY `duplicate_of`, deliberately not `conflict_of` (setting the
     * latter there would misrepresent a clean re-identification as a conflict, and would
     * fire a "Recovered" notification per item during a bulk import). Nothing was lost on
     * this path -- the scan must still find the successor, or the user gets the "this note
     * was deleted" backstop alert for a note that was simply renamed.
     */
    it('migrates to a duplicate_of-only successor (the uuid-alternation path, no conflictOf set)', async () => {
      const controller = (await addTab()) as unknown as {
        item: { uuid: string }
        deinitImmediatelyForSecurity: jest.Mock
      }
      const removedUuid = controller.item.uuid
      const successor = {
        uuid: 'alternated-uuid',
        content_type: 'Note',
        duplicateOf: removedUuid,
        serverUpdatedAtTimestamp: 5,
      }
      items.getItems.mockReturnValue([successor] as never)

      emitRemoved([{ uuid: removedUuid }])
      await Promise.resolve()
      await Promise.resolve()

      expect(controller.deinitImmediatelyForSecurity).toHaveBeenCalledTimes(1)
      expect(group.itemControllers).toHaveLength(1)
      expect(group.itemControllers).not.toContain(controller)
      expect(group.activeItemViewController?.item.uuid).toBe('alternated-uuid')
    })

    /**
     * Standard Red Notes (t97): every conflict-path copy carries BOTH conflict_of AND
     * duplicate_of pointing at the same removed uuid (PayloadsByDuplicating sets
     * duplicate_of unconditionally, conflict_of only when isConflict). Matching both
     * relationships in one OR'd predicate (rather than two separate lookups concatenated)
     * means such an item appears in the candidate set exactly once -- this guards against
     * it being counted twice, or "tying" against its own second appearance and reducing to
     * a wrong/undefined result.
     */
    it('counts an item matching both conflictOf and duplicateOf exactly once, not twice', async () => {
      const controller = (await addTab()) as unknown as { item: { uuid: string } }
      const removedUuid = controller.item.uuid
      const bothFieldsCopy = {
        uuid: 'both-fields-copy-uuid',
        content_type: 'Note',
        conflictOf: removedUuid,
        duplicateOf: removedUuid,
        serverUpdatedAtTimestamp: 5,
      }
      items.getItems.mockReturnValue([bothFieldsCopy] as never)

      emitRemoved([{ uuid: removedUuid }])
      await Promise.resolve()
      await Promise.resolve()

      // A single genuine candidate migrates cleanly -- if it were double-counted by two
      // concatenated lookups, reduce()'s self-comparison would still land on the same
      // object here, so the sharper regression guard is the getItems call count below:
      // exactly one scan of the store, not two.
      expect(group.activeItemViewController?.item.uuid).toBe('both-fields-copy-uuid')
      expect(items.getItems).toHaveBeenCalledTimes(1)
    })

    it('ignores a conflict copy whose conflictOf points at a different (unrelated) uuid', async () => {
      const controller = (await addTab()) as unknown as {
        item: { uuid: string }
        deinitImmediatelyForSecurity: jest.Mock
      }
      const unrelatedCopy = {
        uuid: 'unrelated-copy-uuid',
        content_type: 'Note',
        conflictOf: 'some-other-note-uuid',
        serverUpdatedAtTimestamp: 5,
      }
      items.getItems.mockReturnValue([unrelatedCopy] as never)

      emitRemoved([{ uuid: controller.item.uuid }])
      await Promise.resolve()
      await Promise.resolve()

      // No candidate's conflictOf matches the removed uuid, so this falls back to a
      // plain close rather than "migrating" to an unrelated note.
      expect(controller.deinitImmediatelyForSecurity).toHaveBeenCalledTimes(1)
      expect(group.itemControllers).not.toContain(controller)
    })

    it('preserves tile position when migrating a non-active tile to its rescue copy', async () => {
      const first = (await addTab()) as unknown as { item: { uuid: string } }
      const second = await addTab()
      expect(group.activeItemViewController).toBe(second)

      const rescueCopy = {
        uuid: 'rescue-copy-uuid',
        content_type: 'Note',
        conflictOf: first.item.uuid,
        serverUpdatedAtTimestamp: 1,
      }
      items.getItems.mockReturnValue([rescueCopy] as never)

      emitRemoved([{ uuid: first.item.uuid }])
      await Promise.resolve()
      await Promise.resolve()

      expect(group.itemControllers).toHaveLength(2)
      expect(group.itemControllers[0].item.uuid).toBe('rescue-copy-uuid')
      expect(group.itemControllers[1]).toBe(second)
      // The tile that was active (second) stays active; migrating the OTHER tile must not steal focus.
      expect(group.activeItemViewController).toBe(second)
    })

    it('breaks a tie between multiple conflict copies by picking the most recently updated one', async () => {
      const controller = (await addTab()) as unknown as { item: { uuid: string } }
      const removedUuid = controller.item.uuid
      const older = { uuid: 'older-copy', content_type: 'Note', conflictOf: removedUuid, serverUpdatedAtTimestamp: 1 }
      const newer = { uuid: 'newer-copy', content_type: 'Note', conflictOf: removedUuid, serverUpdatedAtTimestamp: 9 }
      items.getItems.mockReturnValue([older, newer] as never)

      emitRemoved([{ uuid: removedUuid }])
      await Promise.resolve()
      await Promise.resolve()

      expect(group.activeItemViewController?.item.uuid).toBe('newer-copy')
    })

    it('falls back to closing when the rescue copy itself fails to initialize', async () => {
      const controller = (await addTab()) as unknown as {
        item: { uuid: string }
        deinitImmediatelyForSecurity: jest.Mock
      }
      // The mocked FileViewController (unlike the mocked NoteViewController) has no
      // `initialize` method, so routing the rescue copy through it exercises the
      // catch-and-fall-back-to-close path without hand-rolling a rejecting mock.
      const rescueCopy = {
        uuid: 'rescue-copy-uuid',
        content_type: 'File',
        conflictOf: controller.item.uuid,
        serverUpdatedAtTimestamp: 1,
      }
      items.getItems.mockReturnValue([rescueCopy] as never)

      emitRemoved([{ uuid: controller.item.uuid }])
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      expect(controller.deinitImmediatelyForSecurity).toHaveBeenCalledTimes(1)
      expect(group.itemControllers).not.toContain(controller)
    })
  })

  /**
   * Standard Red Notes (t97): a mocked `items.getItems`/`items.conflictsOf` return can
   * only prove the migration logic works GIVEN a lookup result — it cannot prove the
   * lookup itself ever finds anything in reality. That exact gap is how this codebase's
   * first version of this fix shipped calling ItemManager.conflictsOf(), which looks
   * like the right API but is unusable here: Collection.discard() unconditionally wipes
   * the conflictMap entry for a uuid the moment it is discarded (PayloadManager.applyPayloads
   * -> ItemCollection.onChange's `set` then `discard`), including the relationship
   * established moments earlier in the SAME batch when the rescue copy was inserted. A
   * mocked conflictsOf/getItems return sails right past that -- it was never wired to a
   * real Collection, so it can't reproduce the wipe. This test uses the REAL ItemManager
   * and PayloadManager (same pattern as ItemManager.spec.ts), drives the exact production
   * sequence (PayloadManager.emitPayloads applying the conflict copy and the original's
   * tombstone in ONE call, precisely as DeltaRemoteRetrieved/ConflictDelta's
   * DuplicateBaseKeepApply does), and lets the real streamItems observer -- not a manually
   * invoked callback -- deliver the removal. No part of the lookup or the removal
   * detection is mocked.
   */
  it('finds and migrates to the conflict_of rescue copy through a real ItemManager/Collection, not a mocked lookup', async () => {
    const logger = { debug: jest.fn() } as unknown as LoggerInterface
    const internalEventBus = { publish: jest.fn() } as unknown as InternalEventBusInterface
    const payloadManager = new PayloadManager(logger, internalEventBus)
    const realItems = new ItemManager(payloadManager, internalEventBus)

    const originalUuid = 'real-original-note-uuid'
    await payloadManager.emitPayload(
      new DecryptedPayload({
        uuid: originalUuid,
        content_type: ContentType.TYPES.Note,
        content: FillItemContent<NoteContent>({ title: 'original', text: 'unsaved edit' }),
        ...PayloadTimestampDefaults(),
      }),
      PayloadEmitSource.LocalInserted,
    )

    const realGroup = new ItemGroupController(
      realItems,
      {} as MutatorClientInterface,
      {} as SyncServiceInterface,
      { isSignedIn: jest.fn().mockReturnValue(false), getUser: jest.fn() } as unknown as SessionsClientInterface,
      {} as PreferenceServiceInterface,
      {} as ComponentManagerInterface,
      {} as AlertService,
      (() => false) as unknown as IsNativeMobileWeb,
    )

    const originalNote = realItems.findItem(originalUuid)
    await realGroup.createItemController({ note: originalNote as never, openInNewTile: true })
    expect(realGroup.itemControllers).toHaveLength(1)

    // Applied in ONE PayloadManager call -- this is what actually wipes the conflictMap
    // entry conflictsOf() would have needed, and it is what the real sync/conflict-delta
    // code path does (both payloads arrive in the same DeltaEmit).
    await payloadManager.emitPayloads(
      [
        new DecryptedPayload({
          uuid: 'real-rescue-copy-uuid',
          content_type: ContentType.TYPES.Note,
          content: FillItemContent<NoteContent>({
            title: 'original',
            text: 'unsaved edit',
            conflict_of: originalUuid,
          }),
          ...PayloadTimestampDefaults(),
        }),
        new DeletedPayload({
          uuid: originalUuid,
          content_type: ContentType.TYPES.Note,
          content: undefined,
          deleted: true,
          dirty: false,
          ...PayloadTimestampDefaults(),
        }),
      ],
      PayloadEmitSource.RemoteRetrieved,
    )

    // No emitRemoved(...) call: the real ItemManager's own streamItems observer
    // (registered by ItemGroupController's own constructor) delivers this removal.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(realItems.findItem(originalUuid)).toBeUndefined()
    expect(realGroup.activeItemViewController?.item.uuid).toBe('real-rescue-copy-uuid')

    realGroup.deinit()
  })
})

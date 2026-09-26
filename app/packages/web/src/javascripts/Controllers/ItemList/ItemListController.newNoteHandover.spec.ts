import { ContentType, PayloadEmitSource, Result, SNNote, SNTag, SystemViewId, SmartView } from '@standardnotes/snjs'
import { InternalEventBus, ItemManagerInterface } from '@standardnotes/services'
import { WebApplication } from '@/Application/WebApplication'
import { ItemGroupController } from '@/Components/NoteView/Controller/ItemGroupController'
import { NoteViewController } from '@/Components/NoteView/Controller/NoteViewController'
import { NavigationController } from '../Navigation/NavigationController'
import { SearchOptionsController } from '../SearchOptionsController'
import { ItemListController } from './ItemListController'
import { ItemsReloadSource } from './ItemsReloadSource'
import { IsNativeMobileWeb } from '@standardnotes/ui-services'

jest.mock('@standardnotes/toast', () => ({
  addToast: jest.fn(),
  ToastType: { Success: 'success', Error: 'error', Loading: 'loading' },
}))

type StreamRegistration = { types: unknown; callback: (event: Record<string, unknown>) => void }

const makeNote = (uuid: string, createdAtMs: number): SNNote =>
  ({
    uuid,
    title: uuid,
    text: '',
    content_type: ContentType.TYPES.Note,
    created_at: new Date(createdAtMs),
    protected: false,
    payload: {},
  }) as unknown as SNNote

/**
 * Standard Red Notes (t99) — regression cover for "mid writing a note it goes back to same note
 * we were doing before" / "mid typing a new note title it will unfocus from the input title and
 * be borked".
 *
 * Both symptoms are one fault. `ItemGroupController` USED TO close the outgoing editor controller
 * before constructing the incoming one, so across `await controller.initialize()` there was no
 * active item controller at all. `createNewNote` also publishes UnselectAllNotes, so the selection
 * is empty for the whole flow. An item-stream emission landing in that window (the outgoing note's
 * own save propagating and its sync response returning, the tag mutation from inheriting the open
 * tag, a websocket-pushed change) drove `recomputeSelectionAfterItemsReload` into
 * `selectFirstItem()` — which SELECTS and then OPENS the first note in the list, starting a second
 * concurrent open that closed the brand-new note out from under the user. Because NoteView is keyed
 * on `controller.runtimeId`, that also unmounted the title input the user was typing into and
 * discarded its unsaved value.
 *
 * Two things now hold, and both are covered below: the handover keeps the outgoing controller
 * listed until the incoming one is ready (so no reader of `activeItemViewController` /
 * `itemControllers` is ever told "nothing is open" mid-open), and the selection recompute declines
 * to draw any conclusion while an open is in flight (so the about-to-be-replaced outgoing note is
 * not re-selected either).
 *
 * This suite drives the REAL `ItemGroupController` and REAL `NoteViewController`s on purpose: the
 * handover ordering and the in-flight-open flag the guard reads are exactly what is under test, so
 * a fake stand-in for either would test nothing.
 */
describe('new-note editor handover (t99)', () => {
  let application: WebApplication
  let controller: ItemListController
  let group: ItemGroupController
  let streamRegistrations: StreamRegistration[]
  let store: Map<string, SNNote | SNTag>
  let displayed: SNNote[]
  /** Fires while the incoming controller is still initializing (see addTagToNote below). */
  let emitDuringInitialize: (() => Promise<void>) | undefined
  /**
   * Same, for the `openNote` path: a cold-loaded note is a lazy-decrypt "lite" item in the
   * real app, so `initialize()` awaits an IndexedDB read through `sync.getFullContentPayload`.
   */
  let emitDuringRehydrate: (() => Promise<void>) | undefined
  /** What `activeItemViewController` / `itemControllers` looked like inside the window. */
  let observedInsideWindow: { active: string | undefined; openCount: number } | undefined

  /**
   * Must satisfy `selectedTag instanceof SNTag` — createNewNoteController narrows on that to
   * decide whether the new note inherits the open tag, and it is the inherited tag that makes
   * `initialize()` await a real mutation (the window under test). A plain object literal cast to
   * SNTag silently skips that branch and the suite would stop exercising the bug.
   */
  const tag = Object.create(SNTag.prototype, {
    // Own value properties, because SNTag inherits these as getters over `payload.content`,
    // which a prototype-only fake does not have.
    uuid: { value: 'tag-1', enumerable: true },
    title: { value: 'Topic', enumerable: true },
    content_type: { value: ContentType.TYPES.Tag, enumerable: true },
    preferences: { value: undefined, enumerable: true },
    isDailyEntry: { value: false, enumerable: true },
    payload: { value: {}, enumerable: true },
  }) as SNTag
  const noteA = makeNote('note-A', 1000)
  /**
   * A cold-loaded note: `lazyDecryptEnabled` is on in the web app, so its body is stripped and
   * `payload.content` carries the lite marker. That makes `openNote` await a real IndexedDB
   * read inside `initialize()` — the same window the new-note path has.
   */
  const liteNoteC = Object.assign(makeNote('note-C', 2000), {
    payload: { content: { __lazyLite: true } },
  }) as SNNote

  /**
   * A cold-loaded note that lives in a VAULT. Same lite payload (so `initialize()` awaits the
   * IndexedDB read), plus a `key_system_identifier`, which is what makes it subject to
   * ItemListController.closeVaultItemControllers' scrub.
   */
  const liteVaultNoteV = Object.assign(makeNote('note-V', 3000), {
    payload: { content: { __lazyLite: true } },
    key_system_identifier: 'vault-key-system',
  }) as SNNote

  /** Proof that the emission really landed inside the handover window. */
  let emissionLandedInWindow: boolean

  const noteStreamCallbacks = () =>
    streamRegistrations
      .filter(({ types }) => Array.isArray(types) && types.includes(ContentType.TYPES.Note))
      .map(({ callback }) => callback)

  /** A remote/local item change for an ALREADY existing note, i.e. not the new note itself. */
  const emitChangeForNoteA = async () => {
    emissionLandedInWindow = true
    observedInsideWindow = {
      active: group.activeItemViewController?.item?.uuid,
      openCount: group.itemControllers.length,
    }
    for (const callback of noteStreamCallbacks()) {
      callback({ changed: [noteA], inserted: [], removed: [], source: PayloadEmitSource.RemoteSaved })
    }
    // Let the fire-and-forget `void this.reloadItems(...)` the stream kicks off run to
    // completion, so the selection recompute really does execute inside the window.
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  /**
   * Guards this suite against testing nothing: the emission must have fired, and it must have
   * fired while the incoming controller was not yet pushed (i.e. genuinely mid-handover).
   * Deliberately does NOT assert what the group controller reported during the window — that is
   * what the invariant tests below are for — so this check holds both before and after the fix
   * and cannot mask the outcome assertions.
   */
  const expectEmissionLandedMidHandover = () => {
    expect(emissionLandedInWindow).toBe(true)
    expect(observedInsideWindow).toBeDefined()
    expect(observedInsideWindow?.active).not.toBe('new-note')
  }

  beforeEach(() => {
    streamRegistrations = []
    store = new Map<string, SNNote | SNTag>([
      [noteA.uuid, noteA],
      [liteNoteC.uuid, liteNoteC],
      [liteVaultNoteV.uuid, liteVaultNoteV],
      [tag.uuid, tag],
    ])
    displayed = [noteA, liteNoteC]
    emitDuringInitialize = undefined
    emitDuringRehydrate = undefined
    observedInsideWindow = undefined
    emissionLandedInWindow = false

    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: jest.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: jest.fn(),
        removeListener: jest.fn(),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        dispatchEvent: jest.fn(),
      })),
    })

    const items = {
      streamItems: jest.fn((types: unknown, callback: (event: Record<string, unknown>) => void) => {
        streamRegistrations.push({ types, callback })
        return jest.fn()
      }),
      getDisplayableNotes: jest.fn(() => displayed),
      getDisplayableNotesAndFiles: jest.fn(() => displayed),
      setPrimaryItemDisplayOptions: jest.fn(),
      findItem: jest.fn((uuid: string) => store.get(uuid)),
      findSureItem: jest.fn((uuid: string) => store.get(uuid)),
      findItems: jest.fn((uuids: string[]) => uuids.map((uuid) => store.get(uuid)).filter(Boolean)),
      getSortedTagsForItem: jest.fn(() => []),
      itemsReferencingItem: jest.fn(() => []),
      isTemplateItem: jest.fn(() => false),
      createTemplateItem: jest.fn((_contentType: string, content: Record<string, unknown>) => {
        const created = makeNote('new-note', 5000)
        ;(created as unknown as { title: string }).title = (content.title as string) ?? ''
        return created
      }),
    } as unknown as jest.Mocked<ItemManagerInterface>

    const mutator = {
      /**
       * A tag is selected, so the incoming controller inherits it and `initialize()` AWAITS
       * this real mutation before the controller is pushed. In the app this mutation itself
       * emits (the tag gains a note reference) and other emissions — the outgoing note's sync
       * response, a websocket push — land here too. This is the window under test.
       */
      addTagToNote: jest.fn(async () => {
        if (emitDuringInitialize) {
          await emitDuringInitialize()
        }
        return []
      }),
      insertItem: jest.fn(async (item: SNNote) => item),
      changeItem: jest.fn(async (item: unknown) => item),
      emitItemFromPayload: jest.fn(async (payload: unknown) => payload),
      deleteItem: jest.fn(),
    }

    const sync = {
      sync: jest.fn().mockResolvedValue(undefined),
      /**
       * `initialize()` awaits this for a lazy-decrypt "lite" note, which every cold-loaded
       * note in the real app is. Returning undefined ("no full payload on disk") is itself a
       * realistic outcome; the point is that the await really happens.
       */
      getFullContentPayload: jest.fn(async () => {
        if (emitDuringRehydrate) {
          await emitDuringRehydrate()
        }
        return undefined
      }),
    }

    const preferences = {
      getValue: jest.fn((_key: string, fallback: unknown) => fallback),
      getLocalValue: jest.fn((_key: string, fallback: unknown) => fallback),
    }

    group = new ItemGroupController(
      items,
      mutator as never,
      sync as never,
      { getUser: jest.fn() } as never,
      preferences as never,
      { getDefaultEditorIdentifier: jest.fn(() => 'com.standardnotes.plain-text') } as never,
      { alert: jest.fn() } as never,
      { execute: jest.fn().mockReturnValue(Result.ok(false)) } as never,
    )

    application = {
      navigationController: {
        selected: tag,
        selectedFolder: undefined,
        selectedUuid: tag.uuid,
        isInAnySystemView: jest.fn(() => false),
        isInSystemView: jest.fn(() => false),
        isInSmartView: jest.fn(() => false),
        isInHomeView: jest.fn(() => true),
        moveNoteToFolder: jest.fn().mockResolvedValue(undefined),
        selectHomeNavigationView: jest.fn().mockResolvedValue(undefined),
      } as unknown as jest.Mocked<NavigationController>,
      searchOptionsController: {
        includeProtectedContents: false,
        includeArchived: false,
        includeTrashed: false,
      } as unknown as jest.Mocked<SearchOptionsController>,
      isNativeMobileWebUseCase: {
        execute: jest.fn().mockReturnValue(Result.ok(false)),
      } as unknown as IsNativeMobileWeb,
      items,
      sync,
      preferences,
      itemControllerGroup: group,
      vaultDisplayService: { exclusivelyShownVault: undefined },
      protections: {
        authorizeItemAccess: jest.fn().mockResolvedValue(true),
        authorizeProtectedActionForItems: jest.fn(async (candidates: unknown) => candidates),
      },
      options: { allowNoteSelectionStatePersistence: true },
      keyboardService: { activeModifiers: new Set(), cancelAllKeyboardModifiers: jest.fn() },
      paneController: {
        isInMobileView: false,
        activeViewTab: undefined,
        setPaneLayout: jest.fn(),
        closeViewTab: jest.fn(),
        setActiveViewTab: jest.fn(),
      },
      recents: { add: jest.fn() },
      changeAndSaveItem: { execute: jest.fn() },
      desktopManager: undefined,
    } as unknown as jest.Mocked<WebApplication>

    controller = new ItemListController(
      application.keyboardService,
      application.paneController,
      application.navigationController,
      application.searchOptionsController,
      application.items,
      application.sync,
      application.preferences,
      group,
      application.vaultDisplayService,
      application.desktopManager,
      application.protections,
      application.options,
      application.isNativeMobileWebUseCase,
      application.changeAndSaveItem,
      application.recents,
      new InternalEventBus(),
    )
  })

  afterEach(() => {
    controller?.deinit()
  })

  /** Note A open in the editor and highlighted in the list — the state before the "+" press. */
  const openNoteAAsActiveEditor = async () => {
    await group.createItemController({ note: noteA })
    await controller.selectItem(noteA.uuid, true)
    // Creating a note publishes UnselectAllNotes, which NotesController turns into this.
    controller.deselectAll()
  }

  it('keeps the brand-new note in the editor when an item change lands while it is initializing', async () => {
    await openNoteAAsActiveEditor()
    emitDuringInitialize = emitChangeForNoteA

    await controller.createNewNote(undefined, undefined, 'title', false)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expectEmissionLandedMidHandover()

    const active = group.activeItemViewController as NoteViewController | undefined

    expect(active?.item?.uuid).toBe('new-note')
    expect(active?.dealloced).toBe(false)
    expect(group.itemControllers.map((open) => open.item?.uuid)).toEqual(['new-note'])
  })

  it('does not reopen the previously active note behind the new one', async () => {
    await openNoteAAsActiveEditor()
    emitDuringInitialize = emitChangeForNoteA

    await controller.createNewNote(undefined, undefined, 'title', false)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expectEmissionLandedMidHandover()

    expect(group.itemControllers.some((open) => open.item?.uuid === noteA.uuid)).toBe(false)
    expect([...controller.selectedUuids]).not.toContain(noteA.uuid)
  })

  it('still lands on the new note when nothing emits during the window (control)', async () => {
    await openNoteAAsActiveEditor()

    await controller.createNewNote(undefined, undefined, 'title', false)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(group.activeItemViewController?.item?.uuid).toBe('new-note')
    expect(group.itemControllers.map((open) => open.item?.uuid)).toEqual(['new-note'])
  })

  it('still selects the first item on a reload when no open is in flight', async () => {
    // The guard must be scoped to the handover window only: with nothing opening, an empty
    // selection still resolves to the first item exactly as before.
    await controller.reloadItems(ItemsReloadSource.ItemStream)

    expect([...controller.selectedUuids]).toEqual([noteA.uuid])
  })

  it('shields the newly created note from the system-view close heuristic', async () => {
    /**
     * insertTemplatedNote() flips `isTemplateNote` to false SYNCHRONOUSLY, before
     * mutator.insertItem has applied the note to the collection. The template shield is
     * therefore already gone while the note is still absent from the list, which is what arms
     * `closeBecauseActiveItemDoesntExistInCurrentSystemView` in All Notes (the default view).
     */
    Object.assign(application.navigationController, {
      selected: { uuid: SystemViewId.AllNotes, title: 'Notes' } as unknown as SmartView,
      selectedUuid: SystemViewId.AllNotes,
      isInAnySystemView: jest.fn(() => true),
    })

    await openNoteAAsActiveEditor()
    await controller.createNewNote(undefined, undefined, 'title', false)

    const created = group.activeItemViewController as NoteViewController
    expect(created.item?.uuid).toBe('new-note')

    // The note exists for the app but has not reached the displayed list yet.
    ;(created as unknown as { isTemplateNote: boolean }).isTemplateNote = false
    store.set('new-note', created.item)
    displayed = [noteA]

    await controller.reloadItems(ItemsReloadSource.ItemStream)

    expect(created.dealloced).toBe(false)
    expect(group.itemControllers.map((open) => open.item?.uuid)).toEqual(['new-note'])
  })
  it('never reports "nothing is open" while an open is in flight (new-note path)', async () => {
    /**
     * The invariant, tested directly rather than through one reader's symptom. The outgoing
     * controller stays listed until the incoming one is ready, so every reader of
     * `activeItemViewController` / `itemControllers` during the window gets a live, truthful
     * answer -- the outgoing note IS still what the user is looking at until React re-renders.
     * This is what protects the readers beyond the selection recompute: openNote's and
     * openFile's already-open short-circuits, openNoteInNewTile's alreadyOpen scan,
     * closeVaultItemControllers' security sweep, and the CompletedFullSync placeholder check.
     */
    await openNoteAAsActiveEditor()
    emitDuringInitialize = emitChangeForNoteA

    await controller.createNewNote(undefined, undefined, 'title', false)

    expect(observedInsideWindow).toEqual({ active: noteA.uuid, openCount: 1 })
  })

  it('never reports "nothing is open" while an open is in flight (openNote path)', async () => {
    // Same invariant on the plain open path: a cold-loaded ("lite") note makes initialize()
    // await a real IndexedDB read, which is the same window.
    await openNoteAAsActiveEditor()
    emitDuringRehydrate = emitChangeForNoteA

    await controller.openNote(liteNoteC.uuid)

    expect(observedInsideWindow).toEqual({ active: noteA.uuid, openCount: 1 })
    expect(group.activeItemViewController?.item?.uuid).toBe(liteNoteC.uuid)
    expect(group.itemControllers.map((open) => open.item?.uuid)).toEqual([liteNoteC.uuid])
  })

  it('leaves no open in flight after a rejected open, and keeps the outgoing note', async () => {
    /**
     * Belt and braces on the in-flight counter: if a throwing path could leave it set, the
     * early return in recomputeSelectionAfterItemsReload would stop the list ever selecting
     * anything. The increment sits immediately before the `try` whose `finally` decrements it,
     * so there is no statement in between that can throw -- assert that end to end.
     *
     * Deferring the outgoing close to the swap also makes this path strictly safer than before:
     * a failed open now leaves the user on the note they were already editing instead of with
     * nothing open at all.
     */
    await openNoteAAsActiveEditor()
    const boom = new Error('initialize failed')
    ;(application.items.createTemplateItem as jest.Mock).mockImplementation(() => {
      throw boom
    })

    await expect(controller.createNewNote(undefined, undefined, 'title', false)).rejects.toThrow('initialize failed')

    expect(group.isOpeningItemController).toBe(false)
    expect(group.activeItemViewController?.item?.uuid).toBe(noteA.uuid)
  })
  it('refuses to display a vault item whose vault locked while its editor was initializing', async () => {
    /**
     * The reorder keeps the OUTGOING controller listed during the window, so a vault lock landing
     * there can still scrub it. The INCOMING controller is a different matter: it is deliberately
     * not pushed until the synchronous swap, so for the whole of its initialization it is invisible
     * to ItemListController.closeVaultItemControllers, which only walks `itemControllers`. A vault
     * locking during the open of a note FROM that vault therefore could not reach the very editor
     * about to display its plaintext.
     *
     * The lock is modelled the way it actually presents: the vault's items are re-encrypted, so
     * `items.findItem` (which resolves DECRYPTED items only) stops returning the note.
     */
    await openNoteAAsActiveEditor()
    emitDuringRehydrate = async () => {
      store.delete(liteVaultNoteV.uuid)
      await Promise.resolve()
    }

    await controller.openNote(liteVaultNoteV.uuid)

    // openNote swallows the fail-closed cancellation, so assert on the resulting state.
    expect(group.itemControllers.map((open) => open.item?.uuid)).toEqual([noteA.uuid])
    expect(group.activeItemViewController?.item?.uuid).toBe(noteA.uuid)
    expect(group.isOpeningItemController).toBe(false)
  })

  it('still opens a vault item whose vault stays unlocked', async () => {
    // The guard must not refuse the ordinary case.
    await openNoteAAsActiveEditor()

    await controller.openNote(liteVaultNoteV.uuid)

    expect(group.itemControllers.map((open) => open.item?.uuid)).toEqual([liteVaultNoteV.uuid])
  })
  it('does not open a second controller when the row is clicked again mid-open', async () => {
    /**
     * Standard Red Notes (t99): the open-dedupe exposure, with a real trigger.
     *
     * NoteListItem.onClick takes a DIFFERENT path when the clicked row is already selected: it
     * calls `openSingleSelectedItem` directly, bypassing selectItemUsingInstance's
     * `selectedUuids.has(uuid)` dedupe entirely. So the first click selects and opens, React
     * re-renders the row as selected, and a second click — an impatient double-click, which this
     * surface invites because opening a cold-loaded note awaits a real IndexedDB read — reaches
     * `openNote` again while the first open is still inside `await controller.initialize()`.
     *
     * `openNote`'s `activeControllerItem?.uuid === uuid` short-circuit cannot catch it: mid-handover
     * the active controller is the OUTGOING note, so the uuids do not match and the open proceeds.
     * (Before the handover reorder it was `undefined`, which did not match either — the reorder
     * neither caused nor fixed this.) The result is two controllers for the same note.
     */
    await openNoteAAsActiveEditor()

    /**
     * The second click must land INSIDE the window, which means after `replaceSelection` has made
     * the row selected (it runs just before openNote) and while `initialize()` is still awaiting.
     * Firing it from the rehydrate hook pins it there exactly; firing it right after
     * `selectItem(...)` returns its promise does NOT — at that point selectItemUsingInstance is
     * still suspended on `authorizeItemAccess`, before replaceSelection, so selectedItemsCount is
     * 0 and openSingleSelectedItem returns without doing anything.
     */
    let secondOpen: Promise<void> | undefined
    emitDuringRehydrate = async () => {
      expect([...controller.selectedUuids]).toEqual([liteNoteC.uuid])
      secondOpen = controller.openSingleSelectedItem({ userTriggered: true })
      await Promise.resolve()
    }

    await controller.selectItem(liteNoteC.uuid, true)
    await secondOpen
    await new Promise((resolve) => setTimeout(resolve, 0))

    const openedC = group.itemControllers.filter((open) => open.item?.uuid === liteNoteC.uuid)
    expect(openedC).toHaveLength(1)
    expect(group.activeItemViewController?.item?.uuid).toBe(liteNoteC.uuid)
  })
})

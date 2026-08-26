import {
  ContentType,
  NoteType,
  PayloadEmitSource,
  Result,
  SNNote,
  SNTag,
  SystemViewId,
  VaultLockServiceEvent,
} from '@standardnotes/snjs'
import { InternalEventBus, ItemManagerInterface } from '@standardnotes/services'
import { WebApplication } from '@/Application/WebApplication'
import { NavigationController } from '../Navigation/NavigationController'
import { NotesController } from '../NotesController/NotesController'
import { SearchOptionsController } from '../SearchOptionsController'
import { ItemListController } from './ItemListController'
import { ItemsReloadSource } from './ItemsReloadSource'
import { IsNativeMobileWeb } from '@standardnotes/ui-services'
import { runInAction } from 'mobx'
import { ThreadedSearchIndex } from '@/Utils/Items/Search/ThreadedSearchIndex'
import {
  ChecklistEditorOpeningCanceledError,
  ChecklistEditorOwnershipError,
} from '@/Components/NoteView/Controller/ItemGroupController'

describe('item list controller', () => {
  let application: WebApplication
  let controller: ItemListController
  let itemStreamObservers: { types: unknown; callback: (event: Record<string, unknown>) => void }[]

  beforeEach(() => {
    itemStreamObservers = []
    application = {
      navigationController: {} as jest.Mocked<NavigationController>,
      searchOptionsController: {} as jest.Mocked<SearchOptionsController>,
      notesController: {} as jest.Mocked<NotesController>,
      isNativeMobileWebUseCase: {
        execute: jest.fn().mockReturnValue(Result.ok(false)),
      } as unknown as jest.Mocked<IsNativeMobileWeb>,
      items: {
        streamItems: jest.fn((types: unknown, callback: (event: Record<string, unknown>) => void) => {
          itemStreamObservers.push({ types, callback })
          return jest.fn()
        }),
      } as unknown as jest.Mocked<ItemManagerInterface>,
      sync: {
        getFullContentPayload: jest.fn(),
      },
      itemControllerGroup: {
        itemControllers: [],
        closeItemController: jest.fn(),
      },
      vaultDisplayService: {
        getItemVault: jest.fn(),
      },
    } as unknown as jest.Mocked<WebApplication>

    application.addEventObserver = jest.fn()
    application.addWebEventObserver = jest.fn()
    application.isNativeMobileWeb = jest.fn().mockReturnValue(false)

    const eventBus = new InternalEventBus()

    controller = new ItemListController(
      application.keyboardService,
      application.paneController,
      application.navigationController,
      application.searchOptionsController,
      application.items,
      application.sync,
      application.preferences,
      application.itemControllerGroup,
      application.vaultDisplayService,
      application.desktopManager,
      application.protections,
      application.options,
      application.isNativeMobileWebUseCase,
      application.changeAndSaveItem,
      application.recents,
      eventBus,
    )
  })

  afterEach(() => {
    controller?.deinit()
  })

  describe('stale checklist editor opens', () => {
    const note = {
      uuid: 'checklist-note',
      content_type: ContentType.TYPES.Note,
      noteType: NoteType.Super,
    } as SNNote

    beforeEach(() => {
      application.items.findItem = jest.fn().mockReturnValue(note)
      application.itemControllerGroup.createItemController = jest.fn()
      application.itemControllerGroup.itemControllers = []
    })

    it.each([
      ['the primary editor', () => controller.openNote(note.uuid)],
      ['a new tile', () => controller.openNoteInNewTile(note.uuid)],
    ])('settles a security-canceled open for %s without publishing an active-editor change', async (_label, open) => {
      application.itemControllerGroup.createItemController = jest
        .fn()
        .mockRejectedValue(new ChecklistEditorOpeningCanceledError('authorization changed'))
      const publish = jest
        .spyOn(
          controller as unknown as { publishCrossControllerEventSync: (event: unknown) => Promise<void> },
          'publishCrossControllerEventSync',
        )
        .mockResolvedValue(undefined)
      const handOff = jest
        .spyOn(
          controller as unknown as { handOffEditorColumnToOpenedNote: () => void },
          'handOffEditorColumnToOpenedNote',
        )
        .mockImplementation(() => undefined)

      await expect(open()).resolves.toBeUndefined()
      expect(handOff).not.toHaveBeenCalled()
      expect(publish).not.toHaveBeenCalled()
    })

    it('continues to propagate non-cancellation checklist ownership failures', async () => {
      application.itemControllerGroup.createItemController = jest
        .fn()
        .mockRejectedValue(new ChecklistEditorOwnershipError('detached owner durability failed'))

      await expect(controller.openNote(note.uuid)).rejects.toThrow('detached owner durability failed')
    })
  })

  describe('vault plaintext lifecycle', () => {
    const vaultKeySystem = 'vault-key-system'

    const vaultStream = () => {
      const observer = itemStreamObservers.find(({ types }) => types === ContentType.TYPES.VaultListing)
      if (!observer) {
        throw new Error('Vault stream observer was not registered')
      }
      return observer.callback
    }

    const noteStream = () => {
      const observer = itemStreamObservers.find(
        ({ types }) => Array.isArray(types) && types.includes(ContentType.TYPES.Note),
      )
      if (!observer) {
        throw new Error('Note stream observer was not registered')
      }
      return observer.callback
    }

    const retainedVaultController = () => {
      const item = {
        uuid: 'retained-vault-note',
        title: 'Private title',
        text: 'retained vault plaintext',
        content_type: ContentType.TYPES.Note,
        key_system_identifier: vaultKeySystem,
      } as SNNote
      const viewController = { item, runtimeId: 'retained-controller' }
      application.itemControllerGroup.itemControllers = [viewController] as never
      return { item, viewController }
    }

    beforeEach(() => {
      Object.defineProperty(application.navigationController, 'selected', {
        configurable: true,
        get: () => ({ uuid: 'ordinary-tag', content_type: ContentType.TYPES.Tag }) as SNTag,
      })
    })

    it('closes a stale active vault note immediately when item removal arrives in a tag/search view', () => {
      const { item, viewController } = retainedVaultController()
      controller.noteFilterText = 'private search'
      application.items.getDisplayableNotes = jest.fn().mockReturnValue([])
      application.items.getDisplayableNotesAndFiles = jest.fn().mockReturnValue([])

      // The removal payload need not retain vault metadata; the active stale
      // controller is the authoritative signal that plaintext needs scrubbing.
      noteStream()({
        changed: [],
        inserted: [],
        removed: [{ uuid: item.uuid }],
        source: PayloadEmitSource.LocalChanged,
      })

      expect(application.itemControllerGroup.closeItemController).toHaveBeenCalledWith(viewController, {
        securitySensitive: true,
      })
    })

    it('closes retained vault plaintext when the vault is locked before an item-removal event', async () => {
      const { viewController } = retainedVaultController()

      await controller.handleEvent({
        type: VaultLockServiceEvent.VaultLocked,
        payload: { vault: { systemIdentifier: vaultKeySystem } },
      })

      expect(application.itemControllerGroup.closeItemController).toHaveBeenCalledWith(viewController, {
        securitySensitive: true,
      })
    })

    it('closes retained vault plaintext when the vault listing is removed during access revocation', () => {
      const { viewController } = retainedVaultController()
      application.vaultDisplayService.getItemVault = jest.fn().mockImplementation(() => {
        throw new Error('Cannot find vault for item')
      })

      vaultStream()({
        changed: [],
        inserted: [],
        removed: [{ uuid: 'removed-vault-listing' }],
      })

      expect(application.itemControllerGroup.closeItemController).toHaveBeenCalledWith(viewController, {
        securitySensitive: true,
      })
    })

    it('does not security-close an unlocked vault note or a removed non-vault note', async () => {
      retainedVaultController()
      await controller.handleEvent({
        type: VaultLockServiceEvent.VaultUnlocked,
        payload: { vault: { systemIdentifier: vaultKeySystem } },
      })
      expect(application.itemControllerGroup.closeItemController).not.toHaveBeenCalled()

      application.vaultDisplayService.getItemVault = jest.fn().mockReturnValue({ systemIdentifier: vaultKeySystem })
      vaultStream()({
        changed: [],
        inserted: [],
        removed: [{ uuid: 'unrelated-vault-listing' }],
      })
      expect(application.itemControllerGroup.closeItemController).not.toHaveBeenCalled()

      const nonVaultController = {
        item: {
          uuid: 'ordinary-note',
          text: 'ordinary plaintext',
          content_type: ContentType.TYPES.Note,
        },
        runtimeId: 'ordinary-controller',
      }
      application.itemControllerGroup.itemControllers = [nonVaultController] as never
      ;(
        controller as unknown as {
          closeRemovedVaultItemControllers: (removed: { uuid: string }[]) => void
        }
      ).closeRemovedVaultItemControllers([{ uuid: nonVaultController.item.uuid }])

      expect(application.itemControllerGroup.closeItemController).not.toHaveBeenCalled()
    })
  })

  describe('shouldSelectFirstItem', () => {
    beforeEach(() => {
      controller.getFirstNonProtectedItem = jest.fn()

      runInAction(() => {
        controller.selectedUuids = new Set()
      })
    })

    it('should return false if platform is native mobile web', () => {
      application.isNativeMobileWebUseCase.execute = jest.fn().mockReturnValue(Result.ok(true))

      expect(controller.shouldSelectFirstItem(ItemsReloadSource.TagChange)).toBe(false)
    })

    it('should return false first item is file', () => {
      controller.getFirstNonProtectedItem = jest.fn().mockReturnValue({
        content_type: ContentType.TYPES.File,
      })

      expect(controller.shouldSelectFirstItem(ItemsReloadSource.UserTriggeredTagChange)).toBe(false)
    })

    it('should return false if selected tag is daily entry', () => {
      const tag = {
        isDailyEntry: true,
        content_type: ContentType.TYPES.Tag,
      } as jest.Mocked<SNTag>

      Object.defineProperty(application.navigationController, 'selected', {
        get: () => tag,
      })

      expect(controller.shouldSelectFirstItem(ItemsReloadSource.UserTriggeredTagChange)).toBe(false)
    })

    it('should return true if user triggered tag change', () => {
      const tag = {
        content_type: ContentType.TYPES.Tag,
      } as jest.Mocked<SNTag>

      Object.defineProperty(application.navigationController, 'selected', {
        get: () => tag,
      })

      expect(controller.shouldSelectFirstItem(ItemsReloadSource.UserTriggeredTagChange)).toBe(true)
    })

    it('should return false if not user triggered tag change and there is an existing selected item', () => {
      const tag = {
        content_type: ContentType.TYPES.Tag,
      } as jest.Mocked<SNTag>

      runInAction(() => {
        controller.selectedUuids = new Set(['123'])
      })

      Object.defineProperty(application.navigationController, 'selected', {
        get: () => tag,
      })

      expect(controller.shouldSelectFirstItem(ItemsReloadSource.ItemStream)).toBe(false)
    })

    it('should return true if there are no selected items, even if not user triggered', () => {
      expect(controller.shouldSelectFirstItem(ItemsReloadSource.ItemStream)).toBe(true)
    })
  })

  describe('createNewNote', () => {
    let selectHomeNavigationView: jest.Mock

    beforeEach(() => {
      selectHomeNavigationView = jest.fn().mockResolvedValue(undefined)

      ;(controller as unknown as { publishCrossControllerEventSync: jest.Mock }).publishCrossControllerEventSync = jest
        .fn()
        .mockResolvedValue(undefined)
      controller.titleForNewNote = jest.fn().mockReturnValue('title')
      controller.scrollToItem = jest.fn()
      controller.createNewNoteController = jest.fn().mockResolvedValue({ item: { uuid: 'new-note' } })

      Object.assign(application.navigationController, {
        selectHomeNavigationView,
        isInSmartView: jest.fn().mockReturnValue(true),
        isInHomeView: jest.fn().mockReturnValue(false),
        isInSystemView: jest.fn().mockReturnValue(false),
      })
    })

    it('should keep the Untagged smart view active when creating a note', async () => {
      application.navigationController.isInSystemView = jest
        .fn()
        .mockImplementation((id: SystemViewId) => id === SystemViewId.UntaggedNotes)

      await controller.createNewNote()

      expect(selectHomeNavigationView).not.toHaveBeenCalled()
      expect(controller.createNewNoteController).toHaveBeenCalled()
    })

    it('should switch to home view when creating a note from a non-owning smart view (e.g. Archived)', async () => {
      application.navigationController.isInSystemView = jest
        .fn()
        .mockImplementation((id: SystemViewId) => id === SystemViewId.ArchivedNotes)

      await controller.createNewNote()

      expect(selectHomeNavigationView).toHaveBeenCalled()
      expect(controller.createNewNoteController).toHaveBeenCalled()
    })

    it('should not switch views when already in the home (All Notes) view', async () => {
      application.navigationController.isInHomeView = jest.fn().mockReturnValue(true)

      await controller.createNewNote()

      expect(selectHomeNavigationView).not.toHaveBeenCalled()
      expect(controller.createNewNoteController).toHaveBeenCalled()
    })

    it('should not switch views when a regular tag is selected', async () => {
      application.navigationController.isInSmartView = jest.fn().mockReturnValue(false)

      await controller.createNewNote()

      expect(selectHomeNavigationView).not.toHaveBeenCalled()
      expect(controller.createNewNoteController).toHaveBeenCalled()
    })
  })

  describe('AI contextual search ordering', () => {
    type TestItem = { uuid: string; title?: string; text?: string }
    const items: TestItem[] = [
      { uuid: 'a', title: 'Alpha' },
      { uuid: 'b', title: 'Beta' },
      { uuid: 'c', title: 'Gamma' },
    ]

    // Reach the private algorithmic+AI ordering composition.
    const applyOrdering = (): TestItem[] =>
      (controller as unknown as { applySearchOrdering: (i: TestItem[]) => TestItem[] }).applySearchOrdering(items)

    beforeEach(() => {
      // Disable the algorithmic relevance / index reorderings so the test isolates
      // the AI contextual layer (relevance only engages with a query + flag). Turn
      // the index + local BM25 paths OFF via prefs so they short-circuit to the
      // unchanged substring order before the AI layer runs on top.
      ;(controller as unknown as { preferences: { getValue: jest.Mock } }).preferences = {
        getValue: jest.fn((key: string) => {
          if (key === 'searchIndexEnabled' || key === 'aiPoweredSearchEnabled') {
            return false
          }
          return undefined
        }),
      }
      runInAction(() => {
        controller.relevanceSortActive = false
        controller.noteFilterText = ''
      })
    })

    it('default off: ordering is unchanged when no AI order is set', () => {
      runInAction(() => {
        controller.noteFilterText = 'alpha'
      })
      expect(applyOrdering().map((i) => i.uuid)).toEqual(['a', 'b', 'c'])
    })

    it('applies the AI ordering when it matches the current query', () => {
      runInAction(() => {
        controller.noteFilterText = 'alpha'
      })
      controller.setAiContextualOrder('alpha', ['c', 'a'])
      expect(applyOrdering().map((i) => i.uuid)).toEqual(['c', 'a', 'b'])
    })

    it('ignores a stored order computed for a different query', () => {
      runInAction(() => {
        controller.noteFilterText = 'old'
      })
      controller.setAiContextualOrder('old', ['c', 'a'])
      // User changed the query; the stale order must not apply.
      runInAction(() => {
        controller.aiContextualQuery = 'old'
        controller.noteFilterText = 'new'
      })
      expect(applyOrdering().map((i) => i.uuid)).toEqual(['a', 'b', 'c'])
    })

    it('setAiContextualOrder ignores a result whose query no longer matches', () => {
      runInAction(() => {
        controller.noteFilterText = 'current'
      })
      // A late-arriving result for a previous query is dropped.
      controller.setAiContextualOrder('stale', ['c', 'a'])
      expect(controller.aiContextualOrder).toBeNull()
    })

    it('clearAiContextualOrder resets the stored ordering', () => {
      runInAction(() => {
        controller.noteFilterText = 'alpha'
      })
      controller.setAiContextualOrder('alpha', ['c', 'a'])
      controller.clearAiContextualOrder()
      expect(controller.aiContextualOrder).toBeNull()
      expect(controller.aiContextualQuery).toBeNull()
    })
  })

  describe('MaxIndexedNotes ceiling (OOM guard)', () => {
    const setPrefs = (overrides: Record<string, unknown>) => {
      ;(controller as unknown as { preferences: { getValue: jest.Mock } }).preferences = {
        getValue: jest.fn((key: string, fallback: unknown) => (key in overrides ? overrides[key] : fallback)),
      }
    }

    const setDisplayableNoteCount = (count: number) => {
      const notes = Array.from({ length: count }, (_, i) => ({ uuid: `n${i}`, title: 't', noteType: undefined }))
      ;(controller as unknown as { itemManager: { getDisplayableNotes: jest.Mock } }).itemManager = {
        getDisplayableNotes: jest.fn().mockReturnValue(notes),
      }
    }

    // Spy on the prototype so the spy survives any index re-creation inside
    // reconcileSearchIndexOptions (which may swap the instance when prefs change).
    let rebuildSpy: jest.SpyInstance
    beforeEach(() => {
      rebuildSpy = jest.spyOn(ThreadedSearchIndex.prototype, 'rebuild').mockResolvedValue(undefined)
    })
    afterEach(() => {
      rebuildSpy.mockRestore()
    })

    it('skips the full Tier-2 rebuild when displayable notes exceed MaxIndexedNotes', async () => {
      setPrefs({ maxIndexedNotes: 3 })
      setDisplayableNoteCount(5)

      await controller.rebuildSearchIndex()

      expect(rebuildSpy).not.toHaveBeenCalled()
    })

    it('builds the full Tier-2 index when at/under the MaxIndexedNotes ceiling', async () => {
      setPrefs({ maxIndexedNotes: 10 })
      setDisplayableNoteCount(5)
      ;(controller as unknown as { buildIndexableNotes: () => Promise<unknown[]> }).buildIndexableNotes = jest
        .fn()
        .mockResolvedValue([])

      await controller.rebuildSearchIndex()

      expect(rebuildSpy).toHaveBeenCalledTimes(1)
    })
  })

  describe('operator filter over lazy-decrypted ("lite") notes', () => {
    /**
     * `lazyDecryptEnabled` is on in the web app, so a cold-loaded note has its body
     * stripped from memory (`text === ''`) and only the preview stays resident. The model's
     * substring matcher deliberately falls back to that preview, so if the operator
     * predicate read `text` directly the two filters disagreed: the note was admitted by one
     * and dropped by the other, and came back only once something else hydrated it.
     */
    type LiteItem = {
      uuid: string
      title?: string
      text?: string
      preview_plain?: string
      preview_html?: string
      pinned?: boolean
      created_at?: Date
    }

    const filter = (items: LiteItem[]): LiteItem[] =>
      (controller as unknown as { applyOperatorFilter: (i: LiteItem[]) => LiteItem[] }).applyOperatorFilter(items)

    beforeEach(() => {
      application.items.getSortedTagsForItem = jest.fn().mockReturnValue([])
      application.items.itemsReferencingItem = jest.fn().mockReturnValue([])
    })

    it('matches a lite note on its resident preview text', () => {
      const lite: LiteItem = {
        uuid: 'lite',
        title: 'Untitled',
        text: '',
        preview_plain: 'the quarterly needle lives in the body',
        pinned: true,
        created_at: new Date(),
      }

      runInAction(() => {
        controller.noteFilterText = 'is:pinned needle'
      })

      expect(filter([lite]).map((i) => i.uuid)).toEqual(['lite'])
    })

    it('falls back to preview_html with its tags stripped', () => {
      const lite: LiteItem = {
        uuid: 'lite-html',
        title: 'Untitled',
        text: '',
        preview_html: '<p>the quarterly <b>needle</b> lives here</p>',
        pinned: true,
        created_at: new Date(),
      }

      runInAction(() => {
        controller.noteFilterText = 'is:pinned needle'
      })

      expect(filter([lite]).map((i) => i.uuid)).toEqual(['lite-html'])
    })

    it('still rejects a note whose title, body and preview all lack the term', () => {
      const lite: LiteItem = {
        uuid: 'other',
        title: 'Untitled',
        text: '',
        preview_plain: 'nothing relevant here',
        pinned: true,
        created_at: new Date(),
      }

      runInAction(() => {
        controller.noteFilterText = 'is:pinned needle'
      })

      expect(filter([lite])).toEqual([])
    })
  })
})

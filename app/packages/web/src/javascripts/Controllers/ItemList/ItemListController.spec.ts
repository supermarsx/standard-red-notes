import { ContentType, Result, SNTag, SystemViewId } from '@standardnotes/snjs'
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

describe('item list controller', () => {
  let application: WebApplication
  let controller: ItemListController

  beforeEach(() => {
    application = {
      navigationController: {} as jest.Mocked<NavigationController>,
      searchOptionsController: {} as jest.Mocked<SearchOptionsController>,
      notesController: {} as jest.Mocked<NotesController>,
      isNativeMobileWebUseCase: {
        execute: jest.fn().mockReturnValue(Result.ok(false)),
      } as unknown as jest.Mocked<IsNativeMobileWeb>,
      items: {
        streamItems: jest.fn(),
      } as unknown as jest.Mocked<ItemManagerInterface>,
      sync: {
        getFullContentPayload: jest.fn(),
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

      ;(controller as unknown as { publishCrossControllerEventSync: jest.Mock }).publishCrossControllerEventSync =
        jest.fn().mockResolvedValue(undefined)
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
        getValue: jest.fn((key: string, fallback: unknown) =>
          key in overrides ? overrides[key] : fallback,
        ),
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
      rebuildSpy = jest
        .spyOn(ThreadedSearchIndex.prototype, 'rebuild')
        .mockResolvedValue(undefined)
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
})

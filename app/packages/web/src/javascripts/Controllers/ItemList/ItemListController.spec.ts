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
})

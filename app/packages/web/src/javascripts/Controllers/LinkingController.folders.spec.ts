/**
 * Folder attribution from the note header's linking input.
 *
 * A folder is an SNFolder, never an SNTag, so none of the existing tag paths reach it:
 * `getLinkingSearchResults` did not even ask for the Folder content type, and
 * `LinkingController` threw `Invalid item type` for anything that was not a note, file
 * or tag. Membership is also single-valued (`moveNoteToFolder` clears every other
 * folder first), which is why selecting a folder files the note rather than linking it.
 */
import { WebApplication } from '@/Application/WebApplication'
import {
  ContentType,
  FileItem,
  FolderContentType,
  InternalEventBus,
  ItemManagerInterface,
  PreferenceServiceInterface,
  SNFolder,
  SNNote,
} from '@standardnotes/snjs'
import { FilesController } from './FilesController'
import { ItemListController } from './ItemList/ItemListController'
import { LinkingController } from './LinkingController'
import { NavigationController } from './Navigation/NavigationController'
import { SubscriptionController } from './Subscription/SubscriptionController'
import { FeaturesController } from './FeaturesController'
import { getLinkingSearchResults } from '@/Utils/Items/Search/getSearchResults'
import { getIconForItem } from '@/Utils/Items/Icons/getIconForItem'
import { IconNameToSvgMapping } from '@/Components/Icon/IconNameToSvgMapping'

const createNote = (title: string, options: Partial<SNNote> = {}) =>
  ({
    title,
    archived: false,
    trashed: false,
    uuid: `note-${title}`,
    content_type: ContentType.TYPES.Note,
    references: [],
    ...options,
  }) as unknown as SNNote

const createFile = (title: string, options: Partial<FileItem> = {}) =>
  ({
    title,
    archived: false,
    trashed: false,
    uuid: `file-${title}`,
    content_type: ContentType.TYPES.File,
    references: [],
    ...options,
  }) as unknown as FileItem

const createFolder = (title: string, options: { references?: { uuid: string }[]; iconString?: string } = {}) =>
  ({
    title,
    archived: false,
    trashed: false,
    uuid: `folder-${title}`,
    content_type: FolderContentType,
    iconString: options.iconString ?? 'folder',
    references: options.references ?? [],
  }) as unknown as SNFolder

describe('folder attribution', () => {
  let application: WebApplication
  let eventBus: InternalEventBus

  const itemsInStore = (items: unknown[]) => {
    const getItems = jest.fn((contentTypes: string | string[]) => {
      const requested = Array.isArray(contentTypes) ? contentTypes : [contentTypes]
      return items.filter((item) => requested.includes((item as { content_type: string }).content_type))
    })
    return getItems as unknown as ItemManagerInterface['getItems'] & jest.Mock
  }

  beforeEach(() => {
    application = {
      vaults: {} as jest.Mocked<WebApplication['vaults']>,
      sync: {} as jest.Mocked<WebApplication['sync']>,
      mutator: {} as jest.Mocked<WebApplication['mutator']>,
      preferences: {
        getValue: jest.fn().mockReturnValue(true),
      } as unknown as jest.Mocked<PreferenceServiceInterface>,
      itemControllerGroup: {} as jest.Mocked<WebApplication['itemControllerGroup']>,
      navigationController: {} as jest.Mocked<NavigationController>,
      itemListController: {} as jest.Mocked<ItemListController>,
      filesController: {} as jest.Mocked<FilesController>,
      subscriptionController: {} as jest.Mocked<SubscriptionController>,
      featuresController: {} as jest.Mocked<FeaturesController>,
    } as unknown as WebApplication

    application.sync.sync = jest.fn()
    application.mutator.addTagToNote = jest.fn()
    application.navigationController.moveNoteToFolder = jest.fn().mockResolvedValue(undefined)
    application.navigationController.moveFileToFolder = jest.fn().mockResolvedValue(undefined)
    application.featuresController.isVaultsEnabled = jest.fn().mockReturnValue(false)
    application.subscriptionController.hasFirstPartyOnlineOrOfflineSubscription = jest.fn().mockReturnValue(true)

    Object.defineProperty(application, 'items', { value: {} as jest.Mocked<ItemManagerInterface>, writable: true })

    eventBus = {} as jest.Mocked<InternalEventBus>
    eventBus.addEventHandler = jest.fn()
  })

  const controller = () =>
    new LinkingController(
      application.itemListController,
      application.filesController,
      application.subscriptionController,
      application.navigationController,
      application.featuresController,
      application.itemControllerGroup,
      application.vaultDisplayService,
      application.preferences,
      application.items,
      application.mutator,
      application.sync,
      application.vaults,
      eventBus,
    )

  describe('search results', () => {
    it('offers a matching folder when folders are included', () => {
      const note = createNote('Subject')
      const folder = createFolder('Work')
      application.items.getItems = itemsInStore([note, folder])

      const results = getLinkingSearchResults('Wor', application, note, { includeFolders: true })

      expect(results.unlinkedItems.map((item) => item.uuid)).toEqual(['folder-Work'])
    })

    it('does not offer folders to callers that did not ask for them', () => {
      const note = createNote('Subject')
      const folder = createFolder('Work')
      application.items.getItems = itemsInStore([note, folder])

      const results = getLinkingSearchResults('Wor', application, note)

      expect(results.unlinkedItems).toHaveLength(0)
      expect(application.items.getItems).toHaveBeenCalledWith(expect.not.arrayContaining([FolderContentType as string]))
    })

    it('leads the results with folders, ahead of notes', () => {
      const note = createNote('Subject')
      const other = createNote('Work log')
      const folder = createFolder('Work')
      application.items.getItems = itemsInStore([note, other, folder])

      const results = getLinkingSearchResults('Wor', application, note, { includeFolders: true })

      expect(results.unlinkedItems.map((item) => item.uuid)).toEqual(['folder-Work', 'note-Work log'])
    })

    it('does not re-offer the folder the note already lives in', () => {
      const note = createNote('Subject')
      const folder = createFolder('Work', { references: [{ uuid: 'note-Subject' }] })
      application.items.getItems = itemsInStore([note, folder])

      const results = getLinkingSearchResults('Wor', application, note, { includeFolders: true })

      expect(results.unlinkedItems).toHaveLength(0)
      expect(results.linkedItems.map((item) => item.uuid)).toEqual(['folder-Work'])
    })

    it('still offers to create a tag named like an existing folder', () => {
      const note = createNote('Subject')
      const folder = createFolder('Work')
      application.items.getItems = itemsInStore([note, folder])

      const results = getLinkingSearchResults('Work', application, note, { includeFolders: true })

      expect(results.shouldShowCreateTag).toBe(true)
    })
  })

  describe('selecting a folder', () => {
    it('files the note into the folder instead of linking it', async () => {
      const note = createNote('Subject')
      const folder = createFolder('Work')

      await controller().linkItems(note, folder)

      expect(application.navigationController.moveNoteToFolder).toHaveBeenCalledWith(note, folder)
      expect(application.mutator.addTagToNote).not.toHaveBeenCalled()
    })

    it('files a file into the folder', async () => {
      const file = createFile('Report')
      const folder = createFolder('Work')

      await controller().linkItems(file, folder)

      expect(application.navigationController.moveFileToFolder).toHaveBeenCalledWith(file, folder)
    })

    it('leaves syncing to the folder mover rather than syncing the same change twice', async () => {
      const note = createNote('Subject')
      const folder = createFolder('Work')

      await controller().linkItems(note, folder)

      expect(application.sync.sync).not.toHaveBeenCalled()
    })

    it('survives a rejected sync inside the folder mover', async () => {
      const note = createNote('Subject')
      const folder = createFolder('Work')
      application.navigationController.moveNoteToFolder = jest.fn().mockRejectedValue(new Error('sync failed'))
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)

      await expect(controller().linkItems(note, folder)).resolves.toBeUndefined()

      expect(consoleError).toHaveBeenCalled()
      consoleError.mockRestore()
    })
  })

  describe('rendering a folder result', () => {
    it('resolves a real glyph instead of throwing mid-render', () => {
      const folder = createFolder('Work')

      const [icon, className] = getIconForItem(folder, application)

      expect(icon).toBe('folder')
      expect(className).toBe('text-info')
      expect(Object.keys(IconNameToSvgMapping)).toContain(icon)
    })

    it('honours a folder icon the user picked', () => {
      const folder = createFolder('Work', { iconString: 'archive' })

      const [icon] = getIconForItem(folder, application)

      expect(icon).toBe('archive')
      expect(Object.keys(IconNameToSvgMapping)).toContain(icon)
    })

    it('keeps an emoji folder icon, which has no mapping by design', () => {
      const folder = createFolder('Work', { iconString: '📁' })

      const [icon] = getIconForItem(folder, application)

      expect(icon).toBe('📁')
    })

    it('falls back rather than handing Icon a name that resolves to nothing', () => {
      // Not reachable through the icon picker, but sync can deliver it from another
      // client or an older version — and Icon would print it as text.
      const folder = createFolder('Work', { iconString: 'briefcase' })

      const [icon] = getIconForItem(folder, application)

      expect(icon).toBe('folder')
      expect(Object.keys(IconNameToSvgMapping)).toContain(icon)
    })
  })
})

import { isSearchResultAlreadyLinkedToItem } from '@/Utils/Items/Search/isSearchResultAlreadyLinkedToItem'
import { WebApplication } from '@/Application/WebApplication'
import { doesItemMatchSearchQuery } from '@/Utils/Items/Search/doesItemMatchSearchQuery'
import {
  AnonymousReference,
  ContentReferenceType,
  ContentType,
  FileItem,
  FileToNoteReference,
  InternalEventBus,
  SNNote,
  ItemManagerInterface,
  VaultListingInterface,
  ItemInterface,
  InternalFeatureService,
  InternalFeature,
  PreferenceServiceInterface,
  Result,
} from '@standardnotes/snjs'
import { FilesController } from './FilesController'
import { ItemListController } from './ItemList/ItemListController'
import { LinkingController } from './LinkingController'
import { NavigationController } from './Navigation/NavigationController'
import { SubscriptionController } from './Subscription/SubscriptionController'
import { getLinkingSearchResults } from '@/Utils/Items/Search/getSearchResults'
import { FeaturesController } from './FeaturesController'

const createNote = (name: string, options?: Partial<SNNote>) => {
  return {
    title: name,
    archived: false,
    trashed: false,
    uuid: String(Math.random()),
    content_type: ContentType.TYPES.Note,
    ...options,
  } as jest.Mocked<SNNote>
}

const createFile = (name: string, options?: Partial<FileItem>) => {
  return {
    title: name,
    archived: false,
    trashed: false,
    uuid: String(Math.random()),
    content_type: ContentType.TYPES.File,
    ...options,
  } as jest.Mocked<FileItem>
}

describe('LinkingController', () => {
  let application: WebApplication
  let eventBus: InternalEventBus

  beforeEach(() => {
    application = {
      vaults: {} as jest.Mocked<WebApplication['vaults']>,
      alerts: {} as jest.Mocked<WebApplication['alerts']>,
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
    } as unknown as jest.Mocked<WebApplication>

    application.getPreference = jest.fn()
    application.addSingleEventObserver = jest.fn()
    application.sync.sync = jest.fn()
    application.featuresController.isVaultsEnabled = jest.fn().mockReturnValue(true)
    application.featuresController.isEntitledToSharedVaults = jest.fn().mockReturnValue(true)

    Object.defineProperty(application, 'items', { value: {} as jest.Mocked<ItemManagerInterface> })

    eventBus = {} as jest.Mocked<InternalEventBus>
    eventBus.addEventHandler = jest.fn()

    Object.defineProperty(application, 'linkingController', {
      get: () =>
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
        ),
      configurable: true,
    })
  })

  describe('isValidSearchResult', () => {
    it("should not be valid result if it doesn't match query", () => {
      const searchQuery = 'test'

      const file = createFile('anotherFile')

      const isFileValidResult = doesItemMatchSearchQuery(file, searchQuery, application)

      expect(isFileValidResult).toBeFalsy()
    })

    it('should not be valid result if item is archived or trashed', () => {
      const searchQuery = 'test'

      const archived = createFile('test', { archived: true })

      const trashed = createFile('test', { trashed: true })

      const isArchivedFileValidResult = doesItemMatchSearchQuery(archived, searchQuery, application)
      expect(isArchivedFileValidResult).toBeFalsy()

      const isTrashedFileValidResult = doesItemMatchSearchQuery(trashed, searchQuery, application)
      expect(isTrashedFileValidResult).toBeFalsy()
    })

    it('should not be valid result if result is active item', () => {
      const searchQuery = 'test'

      const activeItem = createFile('test', { uuid: 'same-uuid' })

      application.items.getItems = jest.fn().mockReturnValue([activeItem])

      const results = getLinkingSearchResults(searchQuery, application, activeItem)

      expect([...results.unlinkedItems, ...results.linkedItems]).toHaveLength(0)
    })

    it('should be valid result if it matches query even case insensitive', () => {
      const searchQuery = 'test'

      const file = createFile('TeSt')

      application.items.getItems = jest.fn().mockReturnValue([file])

      const isFileValidResult = doesItemMatchSearchQuery(file, searchQuery, application)

      expect(isFileValidResult).toBeTruthy()
    })
  })

  describe('isSearchResultAlreadyLinkedToItem', () => {
    it('should be true if active item & result are same content type & active item references result', () => {
      const activeItem = createFile('test', {
        uuid: 'active-item',
        references: [
          {
            reference_type: ContentReferenceType.FileToFile,
            uuid: 'result',
          } as AnonymousReference,
        ],
      })
      const result = createFile('test', { uuid: 'result', references: [] })

      const isFileAlreadyLinked = isSearchResultAlreadyLinkedToItem(result, activeItem)
      expect(isFileAlreadyLinked).toBeTruthy()
    })

    it('should be false if active item & result are same content type & result references active item', () => {
      const activeItem = createFile('test', {
        uuid: 'active-item',
        references: [],
      })
      const result = createFile('test', {
        uuid: 'result',
        references: [
          {
            reference_type: ContentReferenceType.FileToFile,
            uuid: 'active-item',
          } as AnonymousReference,
        ],
      })

      const isFileAlreadyLinked = isSearchResultAlreadyLinkedToItem(result, activeItem)
      expect(isFileAlreadyLinked).toBeFalsy()
    })

    it('should be true if active item & result are different content type & result references active item', () => {
      const activeNote = createNote('test', {
        uuid: 'active-note',
        references: [],
      })

      const fileResult = createFile('test', {
        uuid: 'file-result',
        references: [
          {
            reference_type: ContentReferenceType.FileToNote,
            uuid: 'active-note',
          } as FileToNoteReference,
        ],
      })

      const isFileResultAlreadyLinked = isSearchResultAlreadyLinkedToItem(fileResult, activeNote)
      expect(isFileResultAlreadyLinked).toBeTruthy()
    })

    it('should be true if active item & result are different content type & active item references result', () => {
      const activeNote = createNote('test', {
        uuid: 'active-note',
        references: [
          {
            reference_type: ContentReferenceType.FileToNote,
            uuid: 'file-result',
          } as FileToNoteReference,
        ],
      })

      const fileResult = createFile('test', {
        uuid: 'file-result',
        references: [],
      })

      const isNoteResultAlreadyLinked = isSearchResultAlreadyLinkedToItem(fileResult, activeNote)
      expect(isNoteResultAlreadyLinked).toBeTruthy()
    })

    it('should be false if active item & result are different content type & neither references the other', () => {
      const activeNote = createNote('test', {
        uuid: 'active-file',
        references: [],
      })

      const fileResult = createFile('test', {
        uuid: 'note-result',
        references: [],
      })

      const isNoteResultAlreadyLinked = isSearchResultAlreadyLinkedToItem(fileResult, activeNote)
      expect(isNoteResultAlreadyLinked).toBeFalsy()
    })
  })

  describe('linkItems', () => {
    it('should move file to same vault as note if file does not belong to any vault', async () => {
      InternalFeatureService.get().enableFeature(InternalFeature.Vaults)

      application.mutator.associateFileWithNote = jest.fn().mockReturnValue({})

      const moveToVaultSpy = (application.vaults.moveItemToVault = jest.fn().mockReturnValue(Result.ok()))

      const note = createNote('test', {
        uuid: 'note',
        references: [],
      })

      const file = createFile('test', {
        uuid: 'file',
        references: [],
      })

      const noteVault = {
        uuid: 'note-vault',
      } as jest.Mocked<VaultListingInterface>

      application.vaults.getItemVault = jest.fn().mockImplementation((item: ItemInterface) => {
        if (item.uuid === note.uuid) {
          return noteVault
        }
        return undefined
      })

      await application.linkingController.linkItems(note, file)

      expect(moveToVaultSpy).toHaveBeenCalled()
    })
  })

  describe('reconcileEditorReferenceChanges', () => {
    const fileReferenceTo = (note: SNNote): FileToNoteReference => ({
      reference_type: ContentReferenceType.FileToNote,
      uuid: note.uuid,
      content_type: ContentType.TYPES.Note,
    })

    const configureItems = (note: SNNote, files: FileItem[]) => {
      const entries: [string, SNNote | FileItem][] = [
        [note.uuid, note],
        ...files.map((file): [string, FileItem] => [file.uuid, file]),
      ]
      const allItems = new Map<string, SNNote | FileItem>(entries)
      const linkedNoteUuids = new Map(
        files.map((file): [string, string | undefined] => [
          file.uuid,
          file.references.find((reference) => reference.uuid === note.uuid)?.uuid,
        ]),
      )

      for (const file of files) {
        Object.defineProperty(file, 'references', {
          configurable: true,
          get: () => {
            const linkedNoteUuid = linkedNoteUuids.get(file.uuid)
            return linkedNoteUuid ? [fileReferenceTo(note)] : []
          },
        })
      }

      application.items.findItem = jest.fn((uuid: string) =>
        allItems.get(uuid),
      ) as unknown as ItemManagerInterface['findItem']
      application.featuresController.isVaultsEnabled = jest.fn().mockReturnValue(false)

      application.mutator.associateFileWithNote = jest.fn(async (file: FileItem, currentNote: SNNote) => {
        linkedNoteUuids.set(file.uuid, currentNote.uuid)
        return file
      })
      application.mutator.unlinkItems = jest.fn(async (_currentNote: SNNote, file: FileItem) => {
        linkedNoteUuids.delete(file.uuid)
        return file
      })

      return { allItems, linkedNoteUuids }
    }

    it('mutates the originating note even if UI selection switches before reconciliation', async () => {
      const originatingNote = createNote('origin', { uuid: 'origin', references: [] })
      const laterSelectedNote = createNote('later selection', { uuid: 'later', references: [] })
      const file = createFile('attachment', {
        uuid: 'file',
        references: [fileReferenceTo(originatingNote)],
      })
      configureItems(originatingNote, [file])
      Object.defineProperty(application.itemListController, 'firstSelectedItem', {
        configurable: true,
        value: laterSelectedNote,
      })

      await application.linkingController.reconcileEditorReferenceChanges(originatingNote, {
        added: [],
        removed: [file.uuid],
      })

      expect(application.mutator.unlinkItems).toHaveBeenCalledTimes(1)
      expect(application.mutator.unlinkItems).toHaveBeenCalledWith(originatingNote, file)
      expect(application.mutator.unlinkItems).not.toHaveBeenCalledWith(laterSelectedNote, file)
      expect(application.sync.sync).toHaveBeenCalledTimes(1)
    })

    it('skips a queued change if its originating note has been deleted', async () => {
      const deletedNote = createNote('deleted', { uuid: 'deleted', references: [] })
      const file = createFile('attachment', { uuid: 'file', references: [] })
      const { allItems } = configureItems(deletedNote, [file])
      allItems.delete(deletedNote.uuid)

      await application.linkingController.reconcileEditorReferenceChanges(deletedNote, {
        added: [file.uuid],
        removed: [],
      })

      expect(application.mutator.associateFileWithNote).not.toHaveBeenCalled()
      expect(application.mutator.unlinkItems).not.toHaveBeenCalled()
      expect(application.sync.sync).not.toHaveBeenCalled()
    })

    it('deduplicates UUIDs and performs one sync for a multi-item committed batch', async () => {
      const note = createNote('origin', { uuid: 'origin', references: [] })
      const firstFile = createFile('first', { uuid: 'first-file', references: [] })
      const secondFile = createFile('second', { uuid: 'second-file', references: [] })
      configureItems(note, [firstFile, secondFile])

      await application.linkingController.reconcileEditorReferenceChanges(note, {
        added: [firstFile.uuid, firstFile.uuid, secondFile.uuid, secondFile.uuid],
        removed: [],
      })

      expect(application.mutator.associateFileWithNote).toHaveBeenCalledTimes(2)
      expect(application.mutator.associateFileWithNote).toHaveBeenNthCalledWith(1, firstFile, note)
      expect(application.mutator.associateFileWithNote).toHaveBeenNthCalledWith(2, secondFile, note)
      expect(application.sync.sync).toHaveBeenCalledTimes(1)
    })

    it('does not mutate or sync when an added editor UUID is already linked', async () => {
      const note = createNote('origin', { uuid: 'origin', references: [] })
      const file = createFile('attachment', {
        uuid: 'file',
        references: [fileReferenceTo(note)],
      })
      configureItems(note, [file])

      await application.linkingController.reconcileEditorReferenceChanges(note, {
        added: [file.uuid],
        removed: [],
      })

      expect(application.mutator.associateFileWithNote).not.toHaveBeenCalled()
      expect(application.sync.sync).not.toHaveBeenCalled()
    })

    it('serializes remove then undo-add and relinks after the final-reference removal', async () => {
      const note = createNote('origin', { uuid: 'origin', references: [] })
      const file = createFile('attachment', {
        uuid: 'file',
        references: [fileReferenceTo(note)],
      })
      const { linkedNoteUuids } = configureItems(note, [file])
      const mutationOrder: string[] = []
      application.mutator.unlinkItems = jest.fn(async () => {
        mutationOrder.push('unlink')
        linkedNoteUuids.delete(file.uuid)
        return file
      })
      application.mutator.associateFileWithNote = jest.fn(async () => {
        mutationOrder.push('link')
        linkedNoteUuids.set(file.uuid, note.uuid)
        return file
      })

      const remove = application.linkingController.reconcileEditorReferenceChanges(note, {
        added: [],
        removed: [file.uuid],
      })
      const undo = application.linkingController.reconcileEditorReferenceChanges(note, {
        added: [file.uuid],
        removed: [],
      })

      await Promise.all([remove, undo])

      expect(mutationOrder).toEqual(['unlink', 'link'])
      expect(file.references).toEqual([fileReferenceTo(note)])
      expect(application.sync.sync).toHaveBeenCalledTimes(2)
    })

    it('continues later queued transactions in order after a relationship mutation fails', async () => {
      const note = createNote('origin', { uuid: 'origin', references: [] })
      const file = createFile('attachment', { uuid: 'file', references: [] })
      const { linkedNoteUuids } = configureItems(note, [file])
      application.mutator.associateFileWithNote = jest
        .fn()
        .mockRejectedValueOnce(new Error('first mutation failed'))
        .mockImplementationOnce(async () => {
          linkedNoteUuids.set(file.uuid, note.uuid)
          return file
        })

      const failed = application.linkingController.reconcileEditorReferenceChanges(note, {
        added: [file.uuid],
        removed: [],
      })
      const retry = application.linkingController.reconcileEditorReferenceChanges(note, {
        added: [file.uuid],
        removed: [],
      })

      await expect(failed).rejects.toThrow('first mutation failed')
      await expect(retry).resolves.toBeUndefined()
      expect(application.mutator.associateFileWithNote).toHaveBeenCalledTimes(2)
      expect(application.sync.sync).toHaveBeenCalledTimes(1)
    })
  })
})

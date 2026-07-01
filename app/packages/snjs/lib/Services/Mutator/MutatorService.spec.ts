import {
  NoteContent,
  SNNote,
  FillItemContent,
  DecryptedPayload,
  PayloadTimestampDefaults,
  MutationType,
  FileItem,
  FileContent,
  SNTag,
} from '@standardnotes/models'
import { ContentType } from '@standardnotes/domain-core'
import { ClientDisplayableError } from '@standardnotes/responses'
import { FilesClientInterface } from '@standardnotes/files'
import { AlertService, InternalEventBusInterface } from '@standardnotes/services'
import { MutatorService, PayloadManager, ItemManager } from '../'
import { UuidGenerator, sleep, LoggerInterface } from '@standardnotes/utils'

const setupRandomUuid = () => {
  UuidGenerator.SetGenerator(() => String(Math.random()))
}

describe('mutator service', () => {
  let mutatorService: MutatorService
  let payloadManager: PayloadManager
  let itemManager: ItemManager

  let internalEventBus: InternalEventBusInterface
  let logger: LoggerInterface
  let alerts: jest.Mocked<AlertService>
  let fileService: jest.Mocked<FilesClientInterface>

  beforeEach(() => {
    setupRandomUuid()
    internalEventBus = {} as jest.Mocked<InternalEventBusInterface>
    internalEventBus.publish = jest.fn()

    logger = {} as jest.Mocked<LoggerInterface>
    logger.debug = jest.fn()

    payloadManager = new PayloadManager(logger, internalEventBus)
    itemManager = new ItemManager(payloadManager, internalEventBus)

    alerts = {} as jest.Mocked<AlertService>
    alerts.alert = jest.fn()

    fileService = {} as jest.Mocked<FilesClientInterface>
    fileService.deleteFile = jest.fn().mockResolvedValue(undefined)

    mutatorService = new MutatorService(itemManager, payloadManager, alerts, internalEventBus)
  })

  const insertNote = (title: string) => {
    const note = new SNNote(
      new DecryptedPayload({
        uuid: String(Math.random()),
        content_type: ContentType.TYPES.Note,
        content: FillItemContent<NoteContent>({
          title: title,
        }),
        ...PayloadTimestampDefaults(),
      }),
    )
    return mutatorService.insertItem(note)
  }

  const insertFile = (name: string, trashed = false) => {
    const file = new FileItem(
      new DecryptedPayload({
        uuid: String(Math.random()),
        content_type: ContentType.TYPES.File,
        content: FillItemContent<FileContent>({
          name,
          trashed,
        } as Partial<FileContent>),
        ...PayloadTimestampDefaults(),
      }),
    )
    return mutatorService.insertItem<FileItem>(file)
  }

  describe('file deletion blob cleanup', () => {
    it('deleting a file item routes through FileService.deleteFile to clean its blob', async () => {
      mutatorService.setFileService(fileService)
      const file = await insertFile('photo.png')

      await mutatorService.setItemToBeDeleted(file)

      expect(fileService.deleteFile).toHaveBeenCalledTimes(1)
      expect(fileService.deleteFile).toHaveBeenCalledWith(expect.objectContaining({ uuid: file.uuid }))
    })

    it('deleting a note does NOT route through FileService.deleteFile', async () => {
      mutatorService.setFileService(fileService)
      const note = await insertNote('hello')

      await mutatorService.setItemToBeDeleted(note)

      expect(fileService.deleteFile).not.toHaveBeenCalled()
    })

    it('empty-trash deletes the blob of a trashed file via FileService.deleteFile', async () => {
      mutatorService.setFileService(fileService)
      const trashedFile = await insertFile('trashed.png', true)
      await insertFile('kept.png', false)

      await mutatorService.emptyTrash()

      expect(fileService.deleteFile).toHaveBeenCalledTimes(1)
      expect(fileService.deleteFile).toHaveBeenCalledWith(expect.objectContaining({ uuid: trashedFile.uuid }))
    })

    it('surfaces an alert and still removes the item when blob deletion fails', async () => {
      fileService.deleteFile = jest.fn().mockResolvedValue(new ClientDisplayableError('offline'))
      mutatorService.setFileService(fileService)
      const file = await insertFile('photo.png')

      await mutatorService.setItemToBeDeleted(file)

      expect(alerts.alert).toHaveBeenCalledTimes(1)
      expect(itemManager.findItem(file.uuid)).toBeUndefined()
    })

    it('does not recurse when FileService.deleteFile calls setItemToBeDeleted back', async () => {
      // Simulate FileService.deleteFile performing the raw item deletion (as the real one does).
      fileService.deleteFile = jest.fn().mockImplementation(async (f: FileItem) => {
        await mutatorService.setItemToBeDeleted(f)
        return undefined
      })
      mutatorService.setFileService(fileService)
      const file = await insertFile('photo.png')

      await mutatorService.setItemToBeDeleted(file)

      expect(fileService.deleteFile).toHaveBeenCalledTimes(1)
      expect(itemManager.findItem(file.uuid)).toBeUndefined()
    })
  })

  describe('insertItem', () => {
    it('should throw if attempting to insert already inserted item', async () => {
      const note = await insertNote('hello')

      expect(mutatorService.insertItem(note)).rejects.toThrow()
    })
  })

  describe('note modifications', () => {
    it('pinning should not update timestamps', async () => {
      const note = await insertNote('hello')
      const pinnedNote = await mutatorService.changeItem(
        note,
        (mutator) => {
          mutator.pinned = true
        },
        MutationType.NoUpdateUserTimestamps,
      )

      expect(note.userModifiedDate).toEqual(pinnedNote?.userModifiedDate)
    })

    it('should update the modification date of duplicated notes', async () => {
      const note = await insertNote('hello')
      await sleep(1, false, 'Delaying duplication by 1ms to create unique timestamps')
      const duplicatedNote = await mutatorService.duplicateItem(note)

      expect(duplicatedNote.userModifiedDate.getTime()).toBeGreaterThan(note.userModifiedDate.getTime())
    })
  })

  describe('linking', () => {
    it('attempting to link file and note should not be allowed if items belong to different vaults', async () => {
      const note = {
        uuid: 'note',
        key_system_identifier: '123',
      } as jest.Mocked<SNNote>

      const file = {
        uuid: 'file',
        key_system_identifier: '456',
      } as jest.Mocked<FileItem>

      const result = await mutatorService.associateFileWithNote(file, note)

      expect(result).toBeUndefined()
    })

    it('attempting to link vaulted tag with non vaulted note should not be permissable', async () => {
      const note = {
        uuid: 'note',
        key_system_identifier: undefined,
      } as jest.Mocked<SNNote>

      const tag = {
        uuid: 'tag',
        key_system_identifier: '456',
      } as jest.Mocked<SNTag>

      const result = await mutatorService.addTagToNote(note, tag, true)

      expect(result).toBeUndefined()
    })

    it('attempting to link vaulted tag with non vaulted file should not be permissable', async () => {
      const tag = {
        uuid: 'tag',
        key_system_identifier: '456',
      } as jest.Mocked<SNTag>

      const file = {
        uuid: 'file',
        key_system_identifier: undefined,
      } as jest.Mocked<FileItem>

      const result = await mutatorService.addTagToFile(file, tag, true)

      expect(result).toBeUndefined()
    })

    it('attempting to link vaulted tag with note belonging to different vault should not be perpermissable', async () => {
      const note = {
        uuid: 'note',
        key_system_identifier: '123',
      } as jest.Mocked<SNNote>

      const tag = {
        uuid: 'tag',
        key_system_identifier: '456',
      } as jest.Mocked<SNTag>

      const result = await mutatorService.addTagToNote(note, tag, true)

      expect(result).toBeUndefined()
    })
  })
})

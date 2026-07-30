import { EncryptionProviderInterface } from './../Encryption/EncryptionProviderInterface'
import { LegacyApiServiceInterface } from '../Api/LegacyApiServiceInterface'
import { HistoryServiceInterface } from '../History/HistoryServiceInterface'
import { PayloadManagerInterface } from '../Payloads/PayloadManagerInterface'
import { StorageServiceInterface } from '../Storage/StorageServiceInterface'
import { SessionsClientInterface } from '../Session/SessionsClientInterface'
import { StatusServiceInterface } from '../Status/StatusServiceInterface'
import { FilesBackupService } from './FilesBackupService'
import { PureCryptoInterface, StreamEncryptor } from '@standardnotes/sncrypto-common'
import { ItemManagerInterface } from '../Item/ItemManagerInterface'
import { InternalEventBusInterface } from '..'
import { AlertService } from '../Alert/AlertService'
import { SyncServiceInterface } from '../Sync/SyncServiceInterface'
import { DirectoryManagerInterface, FileBackupsDevice } from '@standardnotes/files'
import { FileItem } from '@standardnotes/models'

describe('backup service', () => {
  let apiService: LegacyApiServiceInterface
  let itemManager: ItemManagerInterface
  let syncService: SyncServiceInterface
  let alertService: AlertService
  let crypto: PureCryptoInterface
  let status: StatusServiceInterface
  let encryptor: EncryptionProviderInterface
  let internalEventBus: InternalEventBusInterface
  let backupService: FilesBackupService
  let device: FileBackupsDevice & DirectoryManagerInterface
  let session: SessionsClientInterface
  let storage: StorageServiceInterface
  let payloads: PayloadManagerInterface
  let history: HistoryServiceInterface

  beforeEach(() => {
    apiService = {} as jest.Mocked<LegacyApiServiceInterface>
    apiService.addEventObserver = jest.fn()
    apiService.createUserFileValetToken = jest.fn()
    apiService.downloadFile = jest.fn()
    apiService.deleteFile = jest.fn().mockReturnValue({})

    itemManager = {} as jest.Mocked<ItemManagerInterface>
    itemManager.createTemplateItem = jest.fn().mockReturnValue({})
    itemManager.addObserver = jest.fn()

    status = {} as jest.Mocked<StatusServiceInterface>

    device = {} as jest.Mocked<FileBackupsDevice & DirectoryManagerInterface>
    device.getFileBackupReadToken = jest.fn()
    device.readNextChunk = jest.fn()
    device.joinPaths = jest.fn()

    session = {} as jest.Mocked<SessionsClientInterface>

    syncService = {} as jest.Mocked<SyncServiceInterface>
    syncService.sync = jest.fn()

    encryptor = {} as jest.Mocked<EncryptionProviderInterface>

    alertService = {} as jest.Mocked<AlertService>
    alertService.confirm = jest.fn().mockReturnValue(true)
    alertService.alert = jest.fn()

    crypto = {} as jest.Mocked<PureCryptoInterface>
    crypto.base64Decode = jest.fn()
    internalEventBus = {} as jest.Mocked<InternalEventBusInterface>
    internalEventBus.publish = jest.fn()

    payloads = {} as PayloadManagerInterface
    history = {} as HistoryServiceInterface

    storage = {} as StorageServiceInterface
    storage.getValue = jest.fn().mockReturnValue('')

    backupService = new FilesBackupService(
      itemManager,
      apiService,
      encryptor,
      device,
      status,
      crypto,
      storage,
      session,
      payloads,
      history,
      device,
      internalEventBus,
    )
    backupService.getFilesBackupsLocation = jest.fn().mockReturnValue('/')

    crypto.xchacha20StreamInitDecryptor = jest.fn().mockReturnValue({
      state: {},
    } as StreamEncryptor)

    crypto.xchacha20StreamDecryptorPush = jest.fn().mockReturnValue({ message: new Uint8Array([0xaa]), tag: 0 })

    crypto.xchacha20StreamInitEncryptor = jest.fn().mockReturnValue({
      header: 'some-header',
      state: {},
    } as StreamEncryptor)

    crypto.xchacha20StreamEncryptorPush = jest.fn().mockReturnValue(new Uint8Array())
  })

  describe('readEncryptedFileFromBackup', () => {
    it('return failed if no backup', async () => {
      backupService.getFileBackupInfo = jest.fn().mockReturnValue(undefined)

      const result = await backupService.readEncryptedFileFromBackup('123', async () => {})

      expect(result).toEqual('failed')
    })

    it('return success if backup', async () => {
      backupService.getFileBackupInfo = jest.fn().mockReturnValue({})

      device.readNextChunk = jest.fn().mockReturnValue({ chunk: new Uint8Array([]), isLast: true, progress: undefined })

      const result = await backupService.readEncryptedFileFromBackup('123', async () => {})

      expect(result).toEqual('success')
    })

    it('should loop through all chunks until last', async () => {
      backupService.getFileBackupInfo = jest.fn().mockReturnValue({})
      const expectedChunkCount = 3
      let receivedChunkCount = 0

      const mockFn = (device.readNextChunk = jest.fn().mockImplementation(() => {
        receivedChunkCount++

        return { chunk: new Uint8Array([]), isLast: receivedChunkCount === expectedChunkCount, progress: undefined }
      }))

      await backupService.readEncryptedFileFromBackup('123', async () => {})

      expect(mockFn.mock.calls.length).toEqual(expectedChunkCount)
    })
  })

  describe('automatic file backups', () => {
    it('releases a file from the pending set when a backup operation fails so it can be retried', async () => {
      jest.useFakeTimers()
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
      try {
        const file = {
          uuid: 'file-uuid',
          name: 'example.txt',
          payload: {},
        } as FileItem
        const subject = backupService as unknown as {
          handleChangedFiles(files: FileItem[]): Promise<void>
          pendingFiles: Set<string>
        }

        backupService.isFilesBackupsEnabled = jest.fn().mockReturnValue(true)
        device.getFilesBackupsMappingFile = jest.fn().mockResolvedValue({
          version: '1.0.0',
          files: {},
        })
        status.addMessage = jest.fn().mockReturnValue('status-message')
        status.removeMessage = jest.fn()
        encryptor.encryptSplitSingle = jest.fn().mockRejectedValue(new Error('simulated encryption failure'))

        await subject.handleChangedFiles([file])
        expect(subject.pendingFiles.has(file.uuid)).toBe(false)

        await subject.handleChangedFiles([file])
        expect(encryptor.encryptSplitSingle).toHaveBeenCalledTimes(2)
        expect(subject.pendingFiles.has(file.uuid)).toBe(false)
        expect(status.removeMessage).toHaveBeenCalledWith('status-message')
        expect(consoleError).toHaveBeenCalledTimes(2)
      } finally {
        consoleError.mockRestore()
        jest.runOnlyPendingTimers()
        jest.useRealTimers()
      }
    })
  })
})

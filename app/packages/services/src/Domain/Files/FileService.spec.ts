import { EncryptionProviderInterface } from './../Encryption/EncryptionProviderInterface'
import { LegacyApiServiceInterface } from './../Api/LegacyApiServiceInterface'
import { PureCryptoInterface, SodiumTag, StreamEncryptor } from '@standardnotes/sncrypto-common'
import { FileItem } from '@standardnotes/models'
import { ItemManagerInterface } from '../Item/ItemManagerInterface'
import { ChallengeServiceInterface } from '../Challenge'
import { InternalEventBusInterface, MutatorClientInterface } from '..'
import { AlertService } from '../Alert/AlertService'

import { SyncServiceInterface } from '../Sync/SyncServiceInterface'
import { FileService } from './FileService'
import {
  BackupServiceInterface,
  DownloadAndDecryptFileOperation,
  FileHandleRead,
  FileSystemApi,
} from '@standardnotes/files'
import { HttpServiceInterface } from '@standardnotes/api'
import { LoggerInterface } from '@standardnotes/utils'

describe('fileService', () => {
  let apiService: LegacyApiServiceInterface
  let itemManager: ItemManagerInterface
  let mutator: MutatorClientInterface
  let syncService: SyncServiceInterface
  let alertService: AlertService
  let crypto: PureCryptoInterface
  let challengor: ChallengeServiceInterface
  let fileService: FileService
  let encryptor: EncryptionProviderInterface
  let internalEventBus: InternalEventBusInterface
  let backupService: BackupServiceInterface
  let http: HttpServiceInterface

  let logger: LoggerInterface

  beforeEach(() => {
    apiService = {} as jest.Mocked<LegacyApiServiceInterface>
    apiService.addEventObserver = jest.fn()
    apiService.createUserFileValetToken = jest.fn()
    apiService.deleteFile = jest.fn().mockReturnValue({})
    const numChunks = 1
    apiService.downloadFile = jest
      .fn()
      .mockImplementation(
        async (params: {
          file: { encryptedChunkSizes: number[] }
          onBytesReceived: (bytes: Uint8Array) => Promise<void>
          shouldAbort?: () => boolean
        }) => {
          for (let i = 0; i < numChunks; i++) {
            if (params.shouldAbort?.()) {
              break
            }
            await params.onBytesReceived(new Uint8Array(params.file.encryptedChunkSizes[i]))
          }
        },
      )

    itemManager = {} as jest.Mocked<ItemManagerInterface>
    itemManager.createTemplateItem = jest.fn().mockReturnValue({})
    itemManager.addObserver = jest.fn()

    mutator = {} as jest.Mocked<MutatorClientInterface>
    mutator.createItem = jest.fn()
    mutator.setItemToBeDeleted = jest.fn()
    mutator.changeItem = jest.fn()

    challengor = {} as jest.Mocked<ChallengeServiceInterface>

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

    backupService = {} as jest.Mocked<BackupServiceInterface>
    backupService.readEncryptedFileFromBackup = jest.fn()
    backupService.getFileBackupInfo = jest.fn()

    logger = {} as jest.Mocked<LoggerInterface>
    logger.info = jest.fn()

    http = {} as jest.Mocked<HttpServiceInterface>

    fileService = new FileService(
      apiService,
      mutator,
      syncService,
      encryptor,
      challengor,
      http,
      alertService,
      crypto,
      internalEventBus,
      logger,
      backupService,
    )

    crypto.xchacha20StreamInitDecryptor = jest.fn().mockReturnValue({
      state: {},
    } as StreamEncryptor)

    crypto.xchacha20StreamDecryptorPush = jest.fn().mockReturnValue({
      message: new Uint8Array([0xaa]),
      tag: SodiumTag.CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_FINAL,
    })

    crypto.xchacha20StreamInitEncryptor = jest.fn().mockReturnValue({
      header: 'some-header',
      state: {},
    } as StreamEncryptor)

    crypto.xchacha20StreamEncryptorPush = jest.fn().mockReturnValue(new Uint8Array())
  })

  it('should cache file after download', async () => {
    const file = {
      uuid: '1',
      decryptedSize: 100_000,
      encryptedSize: 101_000,
      encryptedChunkSizes: [101_000],
    } as jest.Mocked<FileItem>

    let downloadMock = apiService.downloadFile as jest.Mock

    await fileService.downloadFile(file, async () => {
      return Promise.resolve()
    })

    expect(downloadMock).toHaveBeenCalledTimes(1)

    downloadMock = apiService.downloadFile = jest.fn()

    await fileService.downloadFile(file, async () => {
      return Promise.resolve()
    })

    expect(downloadMock).toHaveBeenCalledTimes(0)

    expect(fileService['encryptedCache'].get(file.uuid)).toBeTruthy()
  })

  it('does not cache an authenticated prefix when the encrypted download ends early', async () => {
    const file = {
      uuid: 'partial-file',
      decryptedSize: 2,
      encryptedSize: 4,
      encryptedChunkSizes: [2, 2],
    } as jest.Mocked<FileItem>
    crypto.xchacha20StreamDecryptorPush = jest.fn().mockReturnValue({
      message: new Uint8Array([0xaa]),
      tag: SodiumTag.CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_PUSH,
    })

    const error = await fileService.downloadFile(file, jest.fn().mockResolvedValue(undefined))

    expect(error?.text).toContain('ended after 1 of 2 encrypted chunks')
    expect(fileService['encryptedCache'].get(file.uuid)).toBeFalsy()
  })

  it.each([
    ['a decryption failure', false],
    [
      'a missing final tag',
      [
        {
          message: new Uint8Array([0xaa]),
          tag: SodiumTag.CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_PUSH,
        },
        {
          message: new Uint8Array([0xbb]),
          tag: SodiumTag.CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_PUSH,
        },
      ],
    ],
    [
      'an early final tag',
      [
        {
          message: new Uint8Array([0xaa]),
          tag: SodiumTag.CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_FINAL,
        },
        {
          message: new Uint8Array([0xbb]),
          tag: SodiumTag.CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_FINAL,
        },
      ],
    ],
  ])('rejects cached file data with %s without emitting plaintext', async (_case, decryptResults) => {
    const file = {
      uuid: `cached-auth-${_case}`,
      encryptedChunkSizes: [2, 2],
    } as jest.Mocked<FileItem>
    fileService['encryptedCache'].add(file.uuid, { encryptedBytes: new Uint8Array(4) })

    if (Array.isArray(decryptResults)) {
      let index = 0
      crypto.xchacha20StreamDecryptorPush = jest.fn().mockImplementation(() => decryptResults[index++])
    } else {
      crypto.xchacha20StreamDecryptorPush = jest.fn().mockReturnValue(false)
    }

    const onBytes = jest.fn().mockResolvedValue(undefined)
    const error = await fileService.downloadFile(file, onBytes)

    expect(error?.text).toContain('integrity check')
    expect(onBytes).not.toHaveBeenCalled()
  })

  it.each([
    ['truncated', new Uint8Array(3)],
    ['oversized', new Uint8Array(5)],
  ])('rejects %s cached encrypted data without emitting plaintext', async (_case, encryptedBytes) => {
    const file = {
      uuid: `cached-size-${_case}`,
      encryptedChunkSizes: [2, 2],
    } as jest.Mocked<FileItem>
    fileService['encryptedCache'].add(file.uuid, { encryptedBytes })
    let index = 0
    crypto.xchacha20StreamDecryptorPush = jest.fn().mockImplementation(() => ({
      message: new Uint8Array([0xaa]),
      tag:
        index++ === 0
          ? SodiumTag.CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_PUSH
          : SodiumTag.CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_FINAL,
    }))

    const onBytes = jest.fn().mockResolvedValue(undefined)
    const error = await fileService.downloadFile(file, onBytes)

    expect(error?.text).toContain('integrity check')
    expect(onBytes).not.toHaveBeenCalled()
  })

  it('accepts an authenticated cached file chunk with empty plaintext', async () => {
    const file = {
      uuid: 'cached-empty-plaintext',
      encryptedChunkSizes: [2],
    } as jest.Mocked<FileItem>
    fileService['encryptedCache'].add(file.uuid, { encryptedBytes: new Uint8Array(2) })
    crypto.xchacha20StreamDecryptorPush = jest.fn().mockReturnValue({
      message: new Uint8Array(),
      tag: SodiumTag.CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_FINAL,
    })

    const onBytes = jest.fn().mockResolvedValue(undefined)
    const error = await fileService.downloadFile(file, onBytes)

    expect(error).toBeUndefined()
    expect(onBytes).toHaveBeenCalledWith(new Uint8Array(), expect.objectContaining({ source: 'memcache' }))
  })

  it('removes the abort listener after a completed network download', async () => {
    const file = {
      uuid: 'listener-cleanup',
      decryptedSize: 1,
      encryptedSize: 1,
      encryptedChunkSizes: [1],
    } as jest.Mocked<FileItem>
    const controller = new AbortController()
    const addListener = jest.spyOn(controller.signal, 'addEventListener')
    const removeListener = jest.spyOn(controller.signal, 'removeEventListener')

    await fileService.downloadFile(file, jest.fn().mockResolvedValue(undefined), { signal: controller.signal })

    const abortHandler = addListener.mock.calls[0][1]
    expect(addListener).toHaveBeenCalledWith('abort', abortHandler, { once: true })
    expect(removeListener).toHaveBeenCalledWith('abort', abortHandler)
  })

  it('deleting file should remove it from cache', async () => {
    const file = {
      uuid: '1',
      decryptedSize: 100_000,
    } as jest.Mocked<FileItem>

    apiService.downloadFile = jest.fn()

    await fileService.downloadFile(file, async () => {
      return Promise.resolve()
    })

    await fileService.deleteFile(file)

    expect(fileService['encryptedCache'].get(file.uuid)).toBeFalsy()
  })

  it('if file fails to delete, should present alert asking if they want to remove item', async () => {
    const file = {
      uuid: '1',
      decryptedSize: 100_000,
    } as jest.Mocked<FileItem>

    const alertMock = (alertService.confirm = jest.fn().mockReturnValue(true))
    const deleteItemMock = (mutator.setItemToBeDeleted = jest.fn())

    apiService.deleteFile = jest.fn().mockReturnValue({ data: { error: true } })

    await fileService.deleteFile(file)

    expect(alertMock).toHaveBeenCalledTimes(1)
    expect(deleteItemMock).toHaveBeenCalledTimes(1)
  })

  it('should download file from network if no backup', async () => {
    const file = {
      uuid: '1',
      decryptedSize: 100_000,
      encryptedSize: 101_000,
      encryptedChunkSizes: [101_000],
    } as jest.Mocked<FileItem>

    backupService.getFileBackupInfo = jest.fn().mockReturnValue(undefined)

    const downloadMock = apiService.downloadFile as jest.Mock

    await fileService.downloadFile(file, async () => {
      return Promise.resolve()
    })

    expect(downloadMock).toHaveBeenCalledTimes(1)
  })

  it('short-circuits before any download work when the signal is already aborted', async () => {
    const file = {
      uuid: '1',
      localOnly: false,
      decryptedSize: 100_000,
      encryptedSize: 101_000,
      encryptedChunkSizes: [101_000],
    } as jest.Mocked<FileItem>

    backupService.getFileBackupInfo = jest.fn().mockReturnValue(undefined)
    const downloadMock = apiService.downloadFile as jest.Mock

    const controller = new AbortController()
    controller.abort()

    const onBytes = jest.fn().mockResolvedValue(undefined)
    const error = await fileService.downloadFile(file, onBytes, { signal: controller.signal })

    expect(error).toBeUndefined()
    // No token minted, no api download, no chunk pumped — nothing ran.
    expect(downloadMock).not.toHaveBeenCalled()
    expect(onBytes).not.toHaveBeenCalled()
  })

  it('does not start a network download when aborted during valet-token creation', async () => {
    const file = {
      uuid: 'abort-during-token',
      localOnly: false,
      encryptedSize: 1,
      encryptedChunkSizes: [1],
      remoteIdentifier: 'remote-1',
      encryptionHeader: 'header',
      key: 'key',
    } as unknown as jest.Mocked<FileItem>
    backupService.getFileBackupInfo = jest.fn().mockResolvedValue(undefined)

    let resolveToken: ((token: string) => void) | undefined
    apiService.createUserFileValetToken = jest.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveToken = resolve
        }),
    )

    const controller = new AbortController()
    const onBytes = jest.fn().mockResolvedValue(undefined)
    const download = fileService.downloadFile(file, onBytes, { signal: controller.signal })

    while (!resolveToken) {
      await Promise.resolve()
    }
    controller.abort()
    resolveToken('valet-token')

    await expect(download).resolves.toBeUndefined()
    expect(apiService.downloadFile).not.toHaveBeenCalled()
    expect(onBytes).not.toHaveBeenCalled()
  })

  it('aborts an in-flight network download when the signal fires mid-flight, pumping no further chunks', async () => {
    const file = {
      uuid: '1',
      localOnly: false,
      decryptedSize: 100_000,
      encryptedSize: 101_000,
      encryptedChunkSizes: [101_000],
      remoteIdentifier: 'remote-1',
      encryptionHeader: 'header',
      key: 'key',
    } as unknown as jest.Mocked<FileItem>

    backupService.getFileBackupInfo = jest.fn().mockReturnValue(undefined)
    apiService.createUserFileValetToken = jest.fn().mockResolvedValue('valet-token')

    const abortSpy = jest.spyOn(DownloadAndDecryptFileOperation.prototype, 'abort')

    const controller = new AbortController()

    // The api download pumps one chunk, then the caller aborts; a subsequent chunk must be
    // dropped by the downloader's aborted-guard. The api promise itself NEVER resolves — proving
    // the call only returns because abort() resolves the downloader's abort race (a hang => RED).
    apiService.downloadFile = jest
      .fn()
      .mockImplementation((params: { onBytesReceived: (bytes: Uint8Array) => Promise<void> }) => {
        return new Promise<void>(() => {
          void params.onBytesReceived(new Uint8Array(101_000)).then(() => {
            controller.abort()
            return params.onBytesReceived(new Uint8Array(101_000))
          })
        })
      })

    const decryptedChunks: Uint8Array[] = []
    const onBytes = jest.fn(async (bytes: Uint8Array) => {
      decryptedChunks.push(bytes)
    })

    const error = await fileService.downloadFile(file, onBytes, { signal: controller.signal })

    // Aborted mid-flight: operation.abort() was invoked via the signal listener, the call
    // resolved without error (aborted != error), and only the pre-abort chunk was pumped.
    expect(abortSpy).toHaveBeenCalledTimes(1)
    expect(error).toBeUndefined()
    expect(decryptedChunks).toHaveLength(1)
    expect(fileService['encryptedCache'].get(file.uuid)).toBeFalsy()

    abortSpy.mockRestore()
  })

  it('should download file from local backup if it exists', async () => {
    const file = {
      uuid: '1',
      decryptedSize: 1,
      encryptedSize: 1,
      encryptedChunkSizes: [1],
    } as jest.Mocked<FileItem>

    backupService.getFileBackupInfo = jest.fn().mockReturnValue({})
    backupService.readEncryptedFileFromBackup = jest.fn().mockImplementation(async (_uuid, onChunk) => {
      await onChunk({
        data: new Uint8Array(1),
        index: 1,
        isLast: true,
        progress: {
          encryptedFileSize: 1,
          encryptedBytesDownloaded: 1,
          encryptedBytesRemaining: 0,
          percentComplete: 100,
          source: 'local',
        },
      })
      return 'success'
    })

    const downloadMock = (apiService.downloadFile = jest.fn())

    const error = await fileService.downloadFile(file, async () => {
      return Promise.resolve()
    })

    expect(error).toBeUndefined()
    expect(downloadMock).toHaveBeenCalledTimes(0)
  })

  it.each(['aborted', 'failed'] as const)('handles a %s backup read as a terminal result', async (readResult) => {
    const file = {
      uuid: `backup-${readResult}`,
      decryptedSize: 1,
      encryptedSize: 1,
      encryptedChunkSizes: [1],
    } as jest.Mocked<FileItem>
    backupService.getFileBackupInfo = jest.fn().mockResolvedValue({})
    backupService.readEncryptedFileFromBackup = jest.fn().mockResolvedValue(readResult)

    const onBytes = jest.fn().mockResolvedValue(undefined)
    const error = await fileService.downloadFile(file, onBytes)

    if (readResult === 'failed') {
      expect(error?.text).toContain('integrity check')
    } else {
      expect(error).toBeUndefined()
    }
    expect(apiService.downloadFile).not.toHaveBeenCalled()
    expect(onBytes).not.toHaveBeenCalled()
  })

  it('returns an error when backup ciphertext is not finalized', async () => {
    const file = {
      uuid: 'backup-missing-final',
      decryptedSize: 1,
      encryptedSize: 1,
      encryptedChunkSizes: [1],
    } as jest.Mocked<FileItem>
    backupService.getFileBackupInfo = jest.fn().mockResolvedValue({})
    backupService.readEncryptedFileFromBackup = jest.fn().mockImplementation(async (_uuid, onChunk) => {
      await onChunk({
        data: new Uint8Array(1),
        index: 1,
        isLast: true,
        progress: {
          encryptedFileSize: 1,
          encryptedBytesDownloaded: 1,
          encryptedBytesRemaining: 0,
          percentComplete: 100,
          source: 'local',
        },
      })
      return 'success'
    })
    crypto.xchacha20StreamDecryptorPush = jest.fn().mockReturnValue({
      message: new Uint8Array([0xaa]),
      tag: SodiumTag.CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_PUSH,
    })

    const onBytes = jest.fn().mockResolvedValue(undefined)
    const error = await fileService.downloadFile(file, onBytes)

    expect(error?.text).toContain('integrity check')
    expect(onBytes).not.toHaveBeenCalled()
  })

  it('does not return a partial in-memory backup when encrypted data is truncated', async () => {
    const file = {
      uuid: 'truncated-file-system-backup',
      encryptedChunkSizes: [2, 2],
      encryptionHeader: 'header',
      remoteIdentifier: 'remote-1',
      key: 'key',
    } as unknown as jest.Mocked<FileItem>
    const fileSystem = {
      readFile: jest.fn().mockImplementation(async (_handle, onBytes) => {
        await onBytes(new Uint8Array(3), true)
        return 'success'
      }),
    } as unknown as FileSystemApi
    crypto.xchacha20StreamDecryptorPush = jest.fn().mockReturnValue({
      message: new Uint8Array([0xaa]),
      tag: SodiumTag.CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_PUSH,
    })

    await expect(fileService.readBackupFileBytesDecrypted({} as FileHandleRead, file, fileSystem)).rejects.toThrow(
      'Unable to authenticate and decrypt backup file',
    )
  })

  it('reports a failed destination stream close instead of a successful decrypted backup save', async () => {
    const file = {
      uuid: 'failed-backup-close',
      name: 'file.txt',
      encryptedChunkSizes: [1],
      encryptionHeader: 'header',
      remoteIdentifier: 'remote-1',
      key: 'key',
    } as unknown as jest.Mocked<FileItem>
    const fileSystem = {
      selectDirectory: jest.fn().mockResolvedValue({}),
      createFile: jest.fn().mockResolvedValue({}),
      readFile: jest.fn().mockImplementation(async (_handle, onBytes) => {
        await onBytes(new Uint8Array(1), true)
        return 'success'
      }),
      saveBytes: jest.fn().mockResolvedValue('success'),
      closeFileWriteStream: jest.fn().mockResolvedValue('failed'),
    } as unknown as FileSystemApi

    await expect(fileService.readBackupFileAndSaveDecrypted({} as FileHandleRead, file, fileSystem)).resolves.toBe(
      'failed',
    )
  })
})

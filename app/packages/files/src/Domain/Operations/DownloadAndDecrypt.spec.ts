import { ClientDisplayableError } from '@standardnotes/responses'
import { PureCryptoInterface, StreamEncryptor } from '@standardnotes/sncrypto-common'
import { FileDownloadProgress } from '../Types/FileDownloadProgress'
import { DownloadAndDecryptFileOperation } from './DownloadAndDecrypt'
import { FileContent } from '@standardnotes/models'
import { FilesApiInterface } from '../Api/FilesApiInterface'

describe('download and decrypt', () => {
  let apiService: FilesApiInterface
  let operation: DownloadAndDecryptFileOperation
  let file: {
    uuid: string
    encryptedChunkSizes: FileContent['encryptedChunkSizes']
    encryptionHeader: FileContent['encryptionHeader']
    remoteIdentifier: FileContent['remoteIdentifier']
    key: FileContent['key']
    shared_vault_uuid: string | undefined
  }
  let crypto: PureCryptoInterface

  const NumChunks = 5

  const chunkOfSize = (size: number) => {
    return new TextEncoder().encode('a'.repeat(size))
  }

  const downloadChunksOfSize = (size: number) => {
    apiService.downloadFile = jest
      .fn()
      .mockImplementation(async (params: { onBytesReceived: (bytes: Uint8Array) => Promise<void> }) => {
        for (let i = 0; i < NumChunks; i++) {
          await params.onBytesReceived(chunkOfSize(size))
        }
      })
  }

  beforeEach(() => {
    apiService = {} as jest.Mocked<FilesApiInterface>
    apiService.createUserFileValetToken = jest.fn()
    downloadChunksOfSize(5)

    crypto = {} as jest.Mocked<PureCryptoInterface>

    crypto.xchacha20StreamInitDecryptor = jest.fn().mockReturnValue({
      state: {},
    } as StreamEncryptor)

    crypto.xchacha20StreamDecryptorPush = jest.fn().mockReturnValue({ message: new Uint8Array([0xaa]), tag: 0 })

    file = {
      uuid: '123',
      encryptedChunkSizes: [100_000],
      remoteIdentifier: '123',
      key: 'secret',
      encryptionHeader: 'some-header',
      shared_vault_uuid: undefined,
    }
  })

  it('run should resolve when operation is complete', async () => {
    let receivedBytes = new Uint8Array()

    operation = new DownloadAndDecryptFileOperation(file, crypto, apiService, 'own')

    await operation.run(async (result) => {
      if (result) {
        receivedBytes = new Uint8Array([...receivedBytes, ...result.decrypted.decryptedBytes])
      }

      await Promise.resolve()
    })

    expect(receivedBytes.length).toEqual(NumChunks)
  })

  it('should abort cleanly when a chunk cannot be decrypted', async () => {
    crypto.xchacha20StreamDecryptorPush = jest.fn().mockReturnValue(false)
    downloadChunksOfSize(5)

    operation = new DownloadAndDecryptFileOperation(file, crypto, apiService, 'own')

    const onBytes = jest.fn().mockResolvedValue(undefined)
    const result = await operation.run(onBytes)

    expect(onBytes).not.toHaveBeenCalled()
    expect(result.aborted).toBe(true)
  })

  it('should abort cleanly when a chunk decrypts to zero bytes', async () => {
    crypto.xchacha20StreamDecryptorPush = jest.fn().mockReturnValue({ message: new Uint8Array([]), tag: 0 })
    downloadChunksOfSize(5)

    operation = new DownloadAndDecryptFileOperation(file, crypto, apiService, 'own')

    const onBytes = jest.fn().mockResolvedValue(undefined)
    const result = await operation.run(onBytes)

    expect(onBytes).not.toHaveBeenCalled()
    expect(result.aborted).toBe(true)
  })

  it('should report failure when the download itself errors', async () => {
    apiService.downloadFile = jest.fn().mockResolvedValue(new ClientDisplayableError('Network down'))

    operation = new DownloadAndDecryptFileOperation(file, crypto, apiService, 'own')

    const result = await operation.run(jest.fn().mockResolvedValue(undefined))

    expect(result.success).toBe(false)
    expect(result.aborted).toBe(false)
    expect(result.error).toBeInstanceOf(ClientDisplayableError)
  })

  it('should report success and no error for a clean download', async () => {
    operation = new DownloadAndDecryptFileOperation(file, crypto, apiService, 'own')

    const result = await operation.run(jest.fn().mockResolvedValue(undefined))

    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.aborted).toBe(false)
  })

  it('should mark the result aborted when the caller aborts', async () => {
    operation = new DownloadAndDecryptFileOperation(file, crypto, apiService, 'own')

    const runPromise = operation.run(jest.fn().mockResolvedValue(undefined))
    operation.abort()

    const result = await runPromise

    expect(result.aborted).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('should correctly report progress', async () => {
    file = {
      uuid: '123',
      encryptedChunkSizes: [100_000, 200_000, 200_000],
      remoteIdentifier: '123',
      key: 'secret',
      encryptionHeader: 'some-header',
      shared_vault_uuid: undefined,
    }

    downloadChunksOfSize(100_000)

    operation = new DownloadAndDecryptFileOperation(file, crypto, apiService, 'own')

    const progress: FileDownloadProgress = await new Promise((resolve) => {
      // eslint-disable-next-line @typescript-eslint/require-await
      void operation.run(async (result) => {
        operation.abort()
        resolve(result.progress)
      })
    })

    expect(progress.encryptedBytesDownloaded).toEqual(100_000)
    expect(progress.encryptedBytesRemaining).toEqual(400_000)
    expect(progress.encryptedFileSize).toEqual(500_000)
    expect(progress.percentComplete).toEqual(20.0)
  })
})

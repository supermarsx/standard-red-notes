import { ClientDisplayableError } from '@standardnotes/responses'
import { PureCryptoInterface, SodiumTag, StreamEncryptor } from '@standardnotes/sncrypto-common'
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

  const downloadDeclaredChunks = () => {
    apiService.downloadFile = jest
      .fn()
      .mockImplementation(
        async (params: {
          file: { encryptedChunkSizes: number[] }
          onBytesReceived: (bytes: Uint8Array) => Promise<void>
          shouldAbort?: () => boolean
        }) => {
          for (const size of params.file.encryptedChunkSizes) {
            if (params.shouldAbort?.()) {
              break
            }
            await params.onBytesReceived(chunkOfSize(size))
          }
        },
      )
  }

  beforeEach(() => {
    apiService = {} as jest.Mocked<FilesApiInterface>
    apiService.createUserFileValetToken = jest.fn()
    downloadDeclaredChunks()

    crypto = {} as jest.Mocked<PureCryptoInterface>

    crypto.xchacha20StreamInitDecryptor = jest.fn().mockReturnValue({
      state: {},
    } as StreamEncryptor)

    file = {
      uuid: '123',
      encryptedChunkSizes: Array.from({ length: NumChunks }, () => 5),
      remoteIdentifier: '123',
      key: 'secret',
      encryptionHeader: 'some-header',
      shared_vault_uuid: undefined,
    }
    let decryptCall = 0
    crypto.xchacha20StreamDecryptorPush = jest.fn().mockImplementation(() => {
      const isFinal = decryptCall === file.encryptedChunkSizes.length - 1
      decryptCall += 1
      return {
        message: new Uint8Array([0xaa]),
        tag: isFinal
          ? SodiumTag.CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_FINAL
          : SodiumTag.CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_PUSH,
      }
    })
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

  it('reports decryption failure as an integrity error, not a successful abort', async () => {
    crypto.xchacha20StreamDecryptorPush = jest.fn().mockReturnValue(false)

    operation = new DownloadAndDecryptFileOperation(file, crypto, apiService, 'own')

    const onBytes = jest.fn().mockResolvedValue(undefined)
    const result = await operation.run(onBytes)

    expect(onBytes).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.aborted).toBe(false)
    expect(result.error?.text).toContain('authenticate and decrypt')
  })

  it('reports authenticated decryptor initialization failure before starting the download', async () => {
    crypto.xchacha20StreamInitDecryptor = jest.fn(() => {
      throw new Error('invalid header')
    })

    operation = new DownloadAndDecryptFileOperation(file, crypto, apiService, 'own')

    const result = await operation.run(jest.fn().mockResolvedValue(undefined))

    expect(result.success).toBe(false)
    expect(result.aborted).toBe(false)
    expect(result.error?.text).toContain('initialize')
    expect(apiService.downloadFile).not.toHaveBeenCalled()
  })

  it('accepts authenticated empty plaintext', async () => {
    file.encryptedChunkSizes = [5]
    crypto.xchacha20StreamDecryptorPush = jest.fn().mockReturnValue({
      message: new Uint8Array(),
      tag: SodiumTag.CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_FINAL,
    })

    operation = new DownloadAndDecryptFileOperation(file, crypto, apiService, 'own')

    const onBytes = jest.fn().mockResolvedValue(undefined)
    const result = await operation.run(onBytes)

    expect(result).toEqual({ success: true, error: undefined, aborted: false })
    expect(onBytes).toHaveBeenCalledWith(
      expect.objectContaining({
        decrypted: { decryptedBytes: new Uint8Array() },
      }),
    )
  })

  it('should report failure when the download itself errors', async () => {
    apiService.downloadFile = jest.fn().mockResolvedValue(new ClientDisplayableError('Network down'))

    operation = new DownloadAndDecryptFileOperation(file, crypto, apiService, 'own')

    const result = await operation.run(jest.fn().mockResolvedValue(undefined))

    expect(result.success).toBe(false)
    expect(result.aborted).toBe(false)
    expect(result.error).toBeInstanceOf(ClientDisplayableError)
  })

  it('converts a rejected network request into a terminal download error', async () => {
    apiService.downloadFile = jest.fn().mockRejectedValue(new Error('connection reset'))
    operation = new DownloadAndDecryptFileOperation(file, crypto, apiService, 'own')

    const result = await operation.run(jest.fn().mockResolvedValue(undefined))

    expect(result.success).toBe(false)
    expect(result.aborted).toBe(false)
    expect(result.error?.text).toContain('failed before its encrypted stream could be authenticated')
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

    expect(result.success).toBe(false)
    expect(result.aborted).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('rejects a stream with no authenticated FINAL tag', async () => {
    file.encryptedChunkSizes = [5, 5]
    crypto.xchacha20StreamDecryptorPush = jest.fn().mockReturnValue({
      message: new Uint8Array([0xaa]),
      tag: SodiumTag.CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_PUSH,
    })
    operation = new DownloadAndDecryptFileOperation(file, crypto, apiService, 'own')

    const result = await operation.run(jest.fn().mockResolvedValue(undefined))

    expect(result.success).toBe(false)
    expect(result.aborted).toBe(false)
    expect(result.error?.text).toContain('without an authenticated final chunk')
  })

  it('rejects an authenticated FINAL before the last declared chunk', async () => {
    file.encryptedChunkSizes = [5, 5]
    crypto.xchacha20StreamDecryptorPush = jest.fn().mockReturnValue({
      message: new Uint8Array([0xaa]),
      tag: SodiumTag.CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_FINAL,
    })
    operation = new DownloadAndDecryptFileOperation(file, crypto, apiService, 'own')
    const onBytes = jest.fn().mockResolvedValue(undefined)

    const result = await operation.run(onBytes)

    expect(result.success).toBe(false)
    expect(result.error?.text).toContain('before the declared end')
    expect(onBytes).not.toHaveBeenCalled()
  })

  it('rejects multiple FINAL tags without forwarding bytes after the first terminal tag', async () => {
    file.encryptedChunkSizes = [5, 5, 5]
    crypto.xchacha20StreamDecryptorPush = jest
      .fn()
      .mockReturnValueOnce({
        message: new Uint8Array([0xaa]),
        tag: SodiumTag.CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_PUSH,
      })
      .mockReturnValue({
        message: new Uint8Array([0xbb]),
        tag: SodiumTag.CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_FINAL,
      })
    operation = new DownloadAndDecryptFileOperation(file, crypto, apiService, 'own')
    const onBytes = jest.fn().mockResolvedValue(undefined)

    const result = await operation.run(onBytes)

    expect(result.success).toBe(false)
    expect(result.error?.text).toContain('before the declared end')
    expect(onBytes).toHaveBeenCalledTimes(1)
    expect(crypto.xchacha20StreamDecryptorPush).toHaveBeenCalledTimes(2)
  })

  it('rejects a FINAL tag that arrives only after the declared last chunk', async () => {
    file.encryptedChunkSizes = [5]
    apiService.downloadFile = jest.fn().mockImplementation(async (params) => {
      await params.onBytesReceived(chunkOfSize(5))
      await params.onBytesReceived(chunkOfSize(5))
      return undefined
    })
    crypto.xchacha20StreamDecryptorPush = jest
      .fn()
      .mockReturnValueOnce({
        message: new Uint8Array([0xaa]),
        tag: SodiumTag.CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_PUSH,
      })
      .mockReturnValue({
        message: new Uint8Array([0xbb]),
        tag: SodiumTag.CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_FINAL,
      })
    operation = new DownloadAndDecryptFileOperation(file, crypto, apiService, 'own')

    const result = await operation.run(jest.fn().mockResolvedValue(undefined))

    expect(result.success).toBe(false)
    expect(result.error?.text).toContain('without an authenticated final chunk')
    expect(crypto.xchacha20StreamDecryptorPush).toHaveBeenCalledTimes(1)
  })

  it('rejects encrypted data delivered after a valid authenticated FINAL', async () => {
    file.encryptedChunkSizes = [5]
    apiService.downloadFile = jest.fn().mockImplementation(async (params) => {
      await params.onBytesReceived(chunkOfSize(5))
      await params.onBytesReceived(chunkOfSize(5))
      return undefined
    })
    crypto.xchacha20StreamDecryptorPush = jest.fn().mockReturnValue({
      message: new Uint8Array([0xaa]),
      tag: SodiumTag.CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_FINAL,
    })
    operation = new DownloadAndDecryptFileOperation(file, crypto, apiService, 'own')
    const onBytes = jest.fn().mockResolvedValue(undefined)

    const result = await operation.run(onBytes)

    expect(result.success).toBe(false)
    expect(result.error?.text).toContain('beyond its encrypted metadata')
    expect(onBytes).toHaveBeenCalledTimes(1)
    expect(crypto.xchacha20StreamDecryptorPush).toHaveBeenCalledTimes(1)
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

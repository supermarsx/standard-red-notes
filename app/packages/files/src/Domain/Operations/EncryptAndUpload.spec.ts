import { EncryptAndUploadFileOperation } from './EncryptAndUpload'
import { PureCryptoInterface, StreamEncryptor } from '@standardnotes/sncrypto-common'
import { FileContent, VaultListingInterface } from '@standardnotes/models'

import { FilesApiInterface } from '../Api/FilesApiInterface'

describe('encrypt and upload', () => {
  let apiService: FilesApiInterface
  let operation: EncryptAndUploadFileOperation
  let file: {
    decryptedSize: FileContent['decryptedSize']
    key: FileContent['key']
    remoteIdentifier: FileContent['remoteIdentifier']
  }
  let crypto: PureCryptoInterface

  const chunkOfSize = (size: number) => {
    return new TextEncoder().encode('a'.repeat(size))
  }

  beforeEach(() => {
    apiService = {} as jest.Mocked<FilesApiInterface>
    apiService.uploadFileBytes = jest.fn().mockReturnValue(true)

    crypto = {} as jest.Mocked<PureCryptoInterface>

    crypto.xchacha20StreamInitEncryptor = jest.fn().mockReturnValue({
      header: 'some-header',
      state: {},
    } as StreamEncryptor)

    crypto.xchacha20StreamEncryptorPush = jest.fn().mockReturnValue(new Uint8Array())

    file = {
      remoteIdentifier: '123',
      key: 'secret',
      decryptedSize: 100,
    }
  })

  it('should initialize encryption header', () => {
    operation = new EncryptAndUploadFileOperation(file, 'api-token', crypto, apiService)

    expect(operation.getResult().encryptionHeader.length).toBeGreaterThan(0)
  })

  it('should return true when a chunk is uploaded', async () => {
    operation = new EncryptAndUploadFileOperation(file, 'api-token', crypto, apiService)

    const bytes = new Uint8Array()
    const success = await operation.pushBytes(bytes, 2, false)

    expect(success).toEqual(true)
  })

  it('should expose the valet token it was constructed with', () => {
    operation = new EncryptAndUploadFileOperation(file, 'api-token', crypto, apiService)

    expect(operation.getValetToken()).toEqual('api-token')
  })

  it('should upload as a user when no vault is supplied', async () => {
    operation = new EncryptAndUploadFileOperation(file, 'api-token', crypto, apiService)

    await operation.pushBytes(chunkOfSize(10), 2, false)

    expect(apiService.uploadFileBytes).toHaveBeenCalledWith('api-token', 'user', 2, expect.any(Uint8Array))
  })

  it('should upload as a user when the vault is not shared', async () => {
    const vault = { sharing: undefined } as unknown as VaultListingInterface
    operation = new EncryptAndUploadFileOperation(file, 'api-token', crypto, apiService, vault)

    await operation.pushBytes(chunkOfSize(10), 2, false)

    expect(apiService.uploadFileBytes).toHaveBeenCalledWith('api-token', 'user', 2, expect.any(Uint8Array))
  })

  it('should upload as a shared vault when the vault is shared', async () => {
    const vault = { sharing: { sharedVaultUuid: 'vault-1' } } as unknown as VaultListingInterface
    operation = new EncryptAndUploadFileOperation(file, 'api-token', crypto, apiService, vault)

    await operation.pushBytes(chunkOfSize(10), 7, false)

    expect(apiService.uploadFileBytes).toHaveBeenCalledWith('api-token', 'shared-vault', 7, expect.any(Uint8Array))
  })

  it('should not count a failed chunk as uploaded but should still record its size', async () => {
    apiService.uploadFileBytes = jest.fn().mockResolvedValue(false)
    operation = new EncryptAndUploadFileOperation(file, 'api-token', crypto, apiService)

    await expect(operation.pushBytes(chunkOfSize(60), 2, false)).resolves.toBe(false)

    expect(operation.getProgress().decryptedBytesUploaded).toEqual(0)
    expect(operation.getResult().finalDecryptedSize).toEqual(60)
    expect(operation.encryptedChunkSizes).toEqual([0])
  })

  it('should correctly report progress', async () => {
    operation = new EncryptAndUploadFileOperation(file, 'api-token', crypto, apiService)

    const bytes = chunkOfSize(60)
    await operation.pushBytes(bytes, 2, false)

    const progress = operation.getProgress()

    expect(progress.decryptedFileSize).toEqual(100)
    expect(progress.decryptedBytesUploaded).toEqual(60)
    expect(progress.decryptedBytesRemaining).toEqual(40)
    expect(progress.percentComplete).toEqual(60.0)
  })
})

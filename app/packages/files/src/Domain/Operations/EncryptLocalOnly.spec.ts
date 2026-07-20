import { FileContent } from '@standardnotes/models'
import { PureCryptoInterface, StreamEncryptor } from '@standardnotes/sncrypto-common'
import { LocalOnlyFileUploadOperation } from './EncryptLocalOnly'

describe('LocalOnlyFileUploadOperation', () => {
  let crypto: PureCryptoInterface
  let file: {
    decryptedSize: FileContent['decryptedSize']
    key: FileContent['key']
    remoteIdentifier: FileContent['remoteIdentifier']
  }

  beforeEach(() => {
    crypto = {} as jest.Mocked<PureCryptoInterface>
    crypto.xchacha20StreamInitEncryptor = jest.fn().mockReturnValue({
      header: 'some-header',
      state: {},
    } as StreamEncryptor)
    // Encrypting appends a marker byte, so the encrypted length differs from the plaintext length.
    crypto.xchacha20StreamEncryptorPush = jest
      .fn()
      .mockImplementation((_stream: unknown, bytes: Uint8Array) => new Uint8Array([...bytes, 0xff]))

    file = { decryptedSize: 100, key: 'secret', remoteIdentifier: 'remote-1' }
  })

  it('should initialise the encryption header on construction', () => {
    const operation = new LocalOnlyFileUploadOperation(file, crypto)

    expect(crypto.xchacha20StreamInitEncryptor).toHaveBeenCalledWith('secret')
    expect(operation.getResult().encryptionHeader).toEqual('some-header')
  })

  it('should report zero decrypted size before any bytes are pushed', () => {
    const operation = new LocalOnlyFileUploadOperation(file, crypto)

    expect(operation.decryptedSize).toEqual(0)
    expect(operation.getEncryptedBytes().encryptedBytes.length).toEqual(0)
    expect(operation.encryptedChunkSizes).toEqual([])
  })

  it('should accumulate the decrypted size across pushes', () => {
    const operation = new LocalOnlyFileUploadOperation(file, crypto)

    operation.pushBytes(new Uint8Array([1, 2, 3]), false)
    operation.pushBytes(new Uint8Array([4, 5]), true)

    expect(operation.decryptedSize).toEqual(5)
  })

  it('should record the encrypted size of each chunk', () => {
    const operation = new LocalOnlyFileUploadOperation(file, crypto)

    operation.pushBytes(new Uint8Array([1, 2, 3]), false)
    operation.pushBytes(new Uint8Array([4, 5]), true)

    expect(operation.encryptedChunkSizes).toEqual([4, 3])
  })

  it('should flag only the final chunk to the encryptor', () => {
    const operation = new LocalOnlyFileUploadOperation(file, crypto)

    operation.pushBytes(new Uint8Array([1]), false)
    operation.pushBytes(new Uint8Array([2]), true)

    const isFinalFlags = (crypto.xchacha20StreamEncryptorPush as jest.Mock).mock.calls.map((call) => call[3])
    expect(isFinalFlags).toEqual([undefined, expect.anything()])
  })

  it('should concatenate the encrypted chunks in push order', () => {
    const operation = new LocalOnlyFileUploadOperation(file, crypto)

    operation.pushBytes(new Uint8Array([1, 2, 3]), false)
    operation.pushBytes(new Uint8Array([4, 5]), true)

    expect(Array.from(operation.getEncryptedBytes().encryptedBytes)).toEqual([1, 2, 3, 0xff, 4, 5, 0xff])
  })

  it('should report the final decrypted size and the file identity in the result', () => {
    const operation = new LocalOnlyFileUploadOperation(file, crypto)

    operation.pushBytes(new Uint8Array([1, 2, 3, 4, 5, 6]), true)

    expect(operation.getResult()).toEqual({
      encryptionHeader: 'some-header',
      finalDecryptedSize: 6,
      key: 'secret',
      remoteIdentifier: 'remote-1',
    })
  })
})

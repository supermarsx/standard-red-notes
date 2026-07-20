import { PureCryptoInterface } from '@standardnotes/sncrypto-common'
import { FileSystemApi } from '../Api/FileSystemApi'
import { FileHandleRead } from '../Api/FileHandleRead'
import { readAndDecryptBackupFileUsingFileSystemAPI } from './ReadAndDecryptBackupFileFileSystemAPI'

const file = {
  encryptionHeader: 'header',
  remoteIdentifier: 'remote-1',
  encryptedChunkSizes: [4, 4],
  key: 'secret',
}

const bytes = (...values: number[]) => new Uint8Array(values)

/** Returns the encrypted bytes with every value incremented, so decryption is observable. */
const decryptingCrypto = (): PureCryptoInterface => {
  const crypto = {} as jest.Mocked<PureCryptoInterface>
  crypto.xchacha20StreamInitDecryptor = jest.fn().mockReturnValue({ state: {} })
  crypto.xchacha20StreamDecryptorPush = jest.fn().mockImplementation((_state: unknown, encrypted: Uint8Array) => ({
    message: encrypted.map((value) => value + 1),
    tag: 0,
  }))
  return crypto
}

/** A FileSystemApi that replays the supplied byte runs through the onBytes callback. */
const fileSystemYielding = (runs: Uint8Array[], result: 'success' | 'failed' | 'aborted' = 'success') =>
  ({
    readFile: jest.fn().mockImplementation(async (_handle: FileHandleRead, onBytes) => {
      for (const run of runs) {
        await onBytes(run)
      }
      return result
    }),
  }) as unknown as FileSystemApi

describe('readAndDecryptBackupFileUsingFileSystemAPI', () => {
  it('should initialise the decryptor from the file header and key', async () => {
    const crypto = decryptingCrypto()

    await readAndDecryptBackupFileUsingFileSystemAPI(
      {} as FileHandleRead,
      file,
      fileSystemYielding([bytes(1, 2, 3, 4)]),
      crypto,
      jest.fn().mockResolvedValue(undefined),
    )

    expect(crypto.xchacha20StreamInitDecryptor).toHaveBeenCalledWith('header', 'secret')
  })

  it('should emit decrypted bytes chunked by the recorded encrypted chunk sizes', async () => {
    const onDecryptedBytes = jest.fn().mockResolvedValue(undefined)

    await readAndDecryptBackupFileUsingFileSystemAPI(
      {} as FileHandleRead,
      file,
      fileSystemYielding([bytes(1, 2, 3, 4, 5, 6, 7, 8)]),
      decryptingCrypto(),
      onDecryptedBytes,
    )

    expect(onDecryptedBytes.mock.calls.map(([chunk]) => Array.from(chunk))).toEqual([
      [2, 3, 4, 5],
      [6, 7, 8, 9],
    ])
  })

  it('should reassemble chunks that arrive split across several reads', async () => {
    const onDecryptedBytes = jest.fn().mockResolvedValue(undefined)

    await readAndDecryptBackupFileUsingFileSystemAPI(
      {} as FileHandleRead,
      file,
      fileSystemYielding([bytes(1, 2), bytes(3, 4, 5), bytes(6, 7, 8)]),
      decryptingCrypto(),
      onDecryptedBytes,
    )

    expect(onDecryptedBytes.mock.calls.map(([chunk]) => Array.from(chunk))).toEqual([
      [2, 3, 4, 5],
      [6, 7, 8, 9],
    ])
  })

  it('should skip chunks the crypto layer refuses to decrypt', async () => {
    const crypto = decryptingCrypto()
    crypto.xchacha20StreamDecryptorPush = jest.fn().mockReturnValue(false)
    const onDecryptedBytes = jest.fn().mockResolvedValue(undefined)

    await readAndDecryptBackupFileUsingFileSystemAPI(
      {} as FileHandleRead,
      file,
      fileSystemYielding([bytes(1, 2, 3, 4)]),
      crypto,
      onDecryptedBytes,
    )

    expect(onDecryptedBytes).not.toHaveBeenCalled()
  })

  it('should propagate the file system result verbatim', async () => {
    await expect(
      readAndDecryptBackupFileUsingFileSystemAPI(
        {} as FileHandleRead,
        file,
        fileSystemYielding([bytes(1, 2, 3, 4)], 'failed'),
        decryptingCrypto(),
        jest.fn().mockResolvedValue(undefined),
      ),
    ).resolves.toBe('failed')
  })
})

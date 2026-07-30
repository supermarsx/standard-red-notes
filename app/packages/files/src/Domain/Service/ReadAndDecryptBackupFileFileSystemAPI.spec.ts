import { PureCryptoInterface, SodiumTag } from '@standardnotes/sncrypto-common'
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
const decryptingCrypto = (
  tags: SodiumTag[] = [
    SodiumTag.CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_PUSH,
    SodiumTag.CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_FINAL,
  ],
  plaintext = (encrypted: Uint8Array) => encrypted.map((value) => value + 1),
): PureCryptoInterface => {
  const crypto = {} as jest.Mocked<PureCryptoInterface>
  let index = 0
  crypto.xchacha20StreamInitDecryptor = jest.fn().mockReturnValue({ state: {} })
  crypto.xchacha20StreamDecryptorPush = jest.fn().mockImplementation((_state: unknown, encrypted: Uint8Array) => ({
    message: plaintext(encrypted),
    tag: tags[index++],
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
      fileSystemYielding([bytes(1, 2, 3, 4, 5, 6, 7, 8)]),
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

  it('fails when the crypto layer refuses to authenticate a chunk', async () => {
    const crypto = decryptingCrypto()
    crypto.xchacha20StreamDecryptorPush = jest.fn().mockReturnValue(false)
    const onDecryptedBytes = jest.fn().mockResolvedValue(undefined)

    const result = await readAndDecryptBackupFileUsingFileSystemAPI(
      {} as FileHandleRead,
      file,
      fileSystemYielding([bytes(1, 2, 3, 4, 5, 6, 7, 8)]),
      crypto,
      onDecryptedBytes,
    )

    expect(result).toBe('failed')
    expect(onDecryptedBytes).not.toHaveBeenCalled()
  })

  it('fails when the crypto layer throws while authenticating a chunk', async () => {
    const crypto = decryptingCrypto()
    crypto.xchacha20StreamDecryptorPush = jest.fn(() => {
      throw new Error('invalid ciphertext')
    })
    const onDecryptedBytes = jest.fn().mockResolvedValue(undefined)

    const result = await readAndDecryptBackupFileUsingFileSystemAPI(
      {} as FileHandleRead,
      file,
      fileSystemYielding([bytes(1, 2, 3, 4, 5, 6, 7, 8)]),
      crypto,
      onDecryptedBytes,
    )

    expect(result).toBe('failed')
    expect(onDecryptedBytes).not.toHaveBeenCalled()
  })

  it('should propagate the file system result verbatim', async () => {
    await expect(
      readAndDecryptBackupFileUsingFileSystemAPI(
        {} as FileHandleRead,
        file,
        fileSystemYielding([], 'failed'),
        decryptingCrypto(),
        jest.fn().mockResolvedValue(undefined),
      ),
    ).resolves.toBe('failed')
  })

  it('allows authenticated chunks with empty plaintext', async () => {
    const onDecryptedBytes = jest.fn().mockResolvedValue(undefined)

    const result = await readAndDecryptBackupFileUsingFileSystemAPI(
      {} as FileHandleRead,
      { ...file, encryptedChunkSizes: [4] },
      fileSystemYielding([bytes(1, 2, 3, 4)]),
      decryptingCrypto([SodiumTag.CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_FINAL], () => new Uint8Array()),
      onDecryptedBytes,
    )

    expect(result).toBe('success')
    expect(onDecryptedBytes).toHaveBeenCalledWith(new Uint8Array())
  })

  it.each([
    [
      'missing final tag',
      bytes(1, 2, 3, 4, 5, 6, 7, 8),
      decryptingCrypto([
        SodiumTag.CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_PUSH,
        SodiumTag.CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_PUSH,
      ]),
    ],
    [
      'early final tag',
      bytes(1, 2, 3, 4, 5, 6, 7, 8),
      decryptingCrypto([
        SodiumTag.CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_FINAL,
        SodiumTag.CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_FINAL,
      ]),
    ],
    ['truncated data', bytes(1, 2, 3, 4, 5, 6, 7), decryptingCrypto()],
    ['trailing data', bytes(1, 2, 3, 4, 5, 6, 7, 8, 9), decryptingCrypto()],
  ])('fails on %s', async (_case, encryptedBytes, crypto) => {
    const result = await readAndDecryptBackupFileUsingFileSystemAPI(
      {} as FileHandleRead,
      file,
      fileSystemYielding([encryptedBytes as Uint8Array]),
      crypto as PureCryptoInterface,
      jest.fn().mockResolvedValue(undefined),
    )

    expect(result).toBe('failed')
  })

  it('does not hide failures from the plaintext consumer', async () => {
    const consumerError = new Error('destination failed')

    await expect(
      readAndDecryptBackupFileUsingFileSystemAPI(
        {} as FileHandleRead,
        file,
        fileSystemYielding([bytes(1, 2, 3, 4, 5, 6, 7, 8)]),
        decryptingCrypto(),
        jest.fn().mockRejectedValue(consumerError),
      ),
    ).rejects.toBe(consumerError)
  })
})

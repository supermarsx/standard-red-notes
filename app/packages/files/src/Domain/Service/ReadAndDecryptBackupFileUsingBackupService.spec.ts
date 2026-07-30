import { PureCryptoInterface, SodiumTag } from '@standardnotes/sncrypto-common'
import { BackupServiceInterface } from './BackupServiceInterface'
import { readAndDecryptBackupFileUsingBackupService } from './ReadAndDecryptBackupFileUsingBackupService'

const file = {
  uuid: 'file-uuid',
  encryptionHeader: 'header',
  remoteIdentifier: 'remote-1',
  encryptedChunkSizes: [4, 4],
  key: 'secret',
}

const bytes = (...values: number[]) => new Uint8Array(values)

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

const backupServiceYielding = (runs: Uint8Array[], result: 'success' | 'failed' | 'aborted' = 'success') =>
  ({
    readEncryptedFileFromBackup: jest.fn().mockImplementation(async (_uuid: string, onChunk) => {
      for (const [index, run] of runs.entries()) {
        await onChunk({
          data: run,
          index: index + 1,
          isLast: false,
          progress: {
            encryptedFileSize: 8,
            encryptedBytesDownloaded: run.length,
            encryptedBytesRemaining: 0,
            percentComplete: 100,
            source: 'local',
          },
        })
      }
      return result
    }),
  }) as unknown as BackupServiceInterface

describe('readAndDecryptBackupFileUsingBackupService', () => {
  it('should read the backup by file uuid', async () => {
    const backupService = backupServiceYielding([bytes(1, 2, 3, 4, 5, 6, 7, 8)])

    const result = await readAndDecryptBackupFileUsingBackupService(
      file,
      backupService,
      decryptingCrypto(),
      jest.fn().mockResolvedValue(undefined),
    )

    expect(result).toBe('success')
    expect(backupService.readEncryptedFileFromBackup).toHaveBeenCalledWith('file-uuid', expect.any(Function))
  })

  it('should emit decrypted chunks that keep the chunker index, isLast and progress', async () => {
    const onDecryptedBytes = jest.fn().mockResolvedValue(undefined)

    await readAndDecryptBackupFileUsingBackupService(
      file,
      backupServiceYielding([bytes(1, 2, 3, 4, 5, 6, 7, 8)]),
      decryptingCrypto(),
      onDecryptedBytes,
    )

    const emitted = onDecryptedBytes.mock.calls.map(([chunk]) => ({
      data: Array.from(chunk.data),
      index: chunk.index,
      source: chunk.progress.source,
    }))

    expect(emitted).toEqual([
      { data: [2, 3, 4, 5], index: 1, source: 'local' },
      { data: [6, 7, 8, 9], index: 2, source: 'local' },
    ])
  })

  it('fails when the crypto layer refuses to authenticate a chunk', async () => {
    const crypto = decryptingCrypto()
    crypto.xchacha20StreamDecryptorPush = jest.fn().mockReturnValue(false)
    const onDecryptedBytes = jest.fn().mockResolvedValue(undefined)

    const result = await readAndDecryptBackupFileUsingBackupService(
      file,
      backupServiceYielding([bytes(1, 2, 3, 4, 5, 6, 7, 8)]),
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

    const result = await readAndDecryptBackupFileUsingBackupService(
      file,
      backupServiceYielding([bytes(1, 2, 3, 4, 5, 6, 7, 8)]),
      crypto,
      onDecryptedBytes,
    )

    expect(result).toBe('failed')
    expect(onDecryptedBytes).not.toHaveBeenCalled()
  })

  it('allows authenticated chunks with empty plaintext', async () => {
    const singleChunkFile = { ...file, encryptedChunkSizes: [4] }
    const onDecryptedBytes = jest.fn().mockResolvedValue(undefined)

    const result = await readAndDecryptBackupFileUsingBackupService(
      singleChunkFile,
      backupServiceYielding([bytes(1, 2, 3, 4)]),
      decryptingCrypto([SodiumTag.CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_FINAL], () => new Uint8Array()),
      onDecryptedBytes,
    )

    expect(result).toBe('success')
    expect(onDecryptedBytes).toHaveBeenCalledWith(expect.objectContaining({ data: new Uint8Array(), isLast: true }))
  })

  it('fails when the final authentication tag is missing', async () => {
    const result = await readAndDecryptBackupFileUsingBackupService(
      file,
      backupServiceYielding([bytes(1, 2, 3, 4, 5, 6, 7, 8)]),
      decryptingCrypto([
        SodiumTag.CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_PUSH,
        SodiumTag.CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_PUSH,
      ]),
      jest.fn().mockResolvedValue(undefined),
    )

    expect(result).toBe('failed')
  })

  it('fails when the final authentication tag arrives before the declared final chunk', async () => {
    const result = await readAndDecryptBackupFileUsingBackupService(
      file,
      backupServiceYielding([bytes(1, 2, 3, 4, 5, 6, 7, 8)]),
      decryptingCrypto([
        SodiumTag.CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_FINAL,
        SodiumTag.CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_FINAL,
      ]),
      jest.fn().mockResolvedValue(undefined),
    )

    expect(result).toBe('failed')
  })

  it.each([
    ['truncated', bytes(1, 2, 3, 4, 5, 6, 7)],
    ['trailing', bytes(1, 2, 3, 4, 5, 6, 7, 8, 9)],
  ])('fails when encrypted backup data is %s', async (_case, encryptedBytes) => {
    const result = await readAndDecryptBackupFileUsingBackupService(
      file,
      backupServiceYielding([encryptedBytes]),
      decryptingCrypto(),
      jest.fn().mockResolvedValue(undefined),
    )

    expect(result).toBe('failed')
  })

  it.each(['aborted', 'failed'] as const)('propagates a %s backup read', async (readResult) => {
    await expect(
      readAndDecryptBackupFileUsingBackupService(
        file,
        backupServiceYielding([], readResult),
        decryptingCrypto(),
        jest.fn().mockResolvedValue(undefined),
      ),
    ).resolves.toBe(readResult)
  })

  it('does not hide failures from the plaintext consumer', async () => {
    const consumerError = new Error('destination failed')

    await expect(
      readAndDecryptBackupFileUsingBackupService(
        file,
        backupServiceYielding([bytes(1, 2, 3, 4, 5, 6, 7, 8)]),
        decryptingCrypto(),
        jest.fn().mockRejectedValue(consumerError),
      ),
    ).rejects.toBe(consumerError)
  })
})

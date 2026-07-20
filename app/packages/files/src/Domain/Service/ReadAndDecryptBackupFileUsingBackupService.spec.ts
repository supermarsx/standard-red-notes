import { PureCryptoInterface } from '@standardnotes/sncrypto-common'
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

const decryptingCrypto = (): PureCryptoInterface => {
  const crypto = {} as jest.Mocked<PureCryptoInterface>
  crypto.xchacha20StreamInitDecryptor = jest.fn().mockReturnValue({ state: {} })
  crypto.xchacha20StreamDecryptorPush = jest.fn().mockImplementation((_state: unknown, encrypted: Uint8Array) => ({
    message: encrypted.map((value) => value + 1),
    tag: 0,
  }))
  return crypto
}

const backupServiceYielding = (runs: Uint8Array[], result: 'success' | 'failed' | 'aborted' = 'success') =>
  ({
    readEncryptedFileFromBackup: jest.fn().mockImplementation(async (_uuid: string, onChunk) => {
      for (const run of runs) {
        await onChunk({
          data: run,
          index: 1,
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
    const backupService = backupServiceYielding([bytes(1, 2, 3, 4)])

    await readAndDecryptBackupFileUsingBackupService(
      file,
      backupService,
      decryptingCrypto(),
      jest.fn().mockResolvedValue(undefined),
    )

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

  it('should skip chunks the crypto layer refuses to decrypt', async () => {
    const crypto = decryptingCrypto()
    crypto.xchacha20StreamDecryptorPush = jest.fn().mockReturnValue(false)
    const onDecryptedBytes = jest.fn().mockResolvedValue(undefined)

    await readAndDecryptBackupFileUsingBackupService(
      file,
      backupServiceYielding([bytes(1, 2, 3, 4)]),
      crypto,
      onDecryptedBytes,
    )

    expect(onDecryptedBytes).not.toHaveBeenCalled()
  })

  it('should propagate the backup service result verbatim', async () => {
    await expect(
      readAndDecryptBackupFileUsingBackupService(
        file,
        backupServiceYielding([bytes(1, 2, 3, 4)], 'aborted'),
        decryptingCrypto(),
        jest.fn().mockResolvedValue(undefined),
      ),
    ).resolves.toBe('aborted')
  })
})

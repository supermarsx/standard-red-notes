import { EncryptAndUploadFileOperation } from './EncryptAndUpload'
import { PureCryptoInterface, StreamEncryptor } from '@standardnotes/sncrypto-common'
import { FileContent } from '@standardnotes/models'
import { FilesApiInterface } from '../Api/FilesApiInterface'

/**
 * Standard Red Notes — DATA-SAFETY reproduction.
 *
 * Reproduces the "large file attachments have SILENT sync failures" defect at the
 * operation boundary that the web FilesController drives.
 *
 * Background (see report): the web `FilesController.uploadNewFile` chunk loop calls
 * `await this.files.pushBytesForUpload(operation, data, index, isLast)` and DISCARDS
 * the returned value (FilesController.ts:848). `pushBytesForUpload` does NOT throw on
 * a failed chunk — it RETURNS a `ClientDisplayableError` (FileService.ts:379-381),
 * which is derived from `EncryptAndUploadFileOperation.pushBytes` returning `false`
 * (EncryptAndUpload.ts:67-73), which itself comes from `uploadFileBytes` returning
 * `false` on any network/4xx/5xx error (ApiService.ts:1313-1317).
 *
 * Consequences proven below:
 *  1. A failed chunk returns `false` but does NOT abort the operation — the loop in
 *     the controller keeps pushing subsequent chunks. The operation is happy to keep
 *     going, so a multi-chunk (large) file can have a hole in the middle.
 *  2. `getResult().finalDecryptedSize` reflects ALL bytes that were *pushed* (encrypted),
 *     not the bytes actually *uploaded* — so the FileItem metadata that `finishUpload`
 *     persists/syncs claims the full size even though bytes are missing on the server.
 *     This is the "ghost attachment": metadata syncs, bytes are incomplete, and nothing
 *     in this layer signals the mismatch.
 */
describe('SILENT large-file upload failure (data-safety repro)', () => {
  let apiService: jest.Mocked<FilesApiInterface>
  let crypto: jest.Mocked<PureCryptoInterface>
  let file: {
    decryptedSize: FileContent['decryptedSize']
    key: FileContent['key']
    remoteIdentifier: FileContent['remoteIdentifier']
  }

  const chunkOfSize = (size: number) => new TextEncoder().encode('a'.repeat(size))

  beforeEach(() => {
    apiService = {} as jest.Mocked<FilesApiInterface>
    crypto = {} as jest.Mocked<PureCryptoInterface>

    crypto.xchacha20StreamInitEncryptor = jest
      .fn()
      .mockReturnValue({ header: 'some-header', state: {} } as StreamEncryptor)
    // Encrypt is a passthrough-by-length stub so byte accounting is meaningful.
    crypto.xchacha20StreamEncryptorPush = jest
      .fn()
      .mockImplementation((_s, message: Uint8Array) => new Uint8Array(message.length))

    file = { remoteIdentifier: '123', key: 'secret', decryptedSize: 150 }
  })

  it('a mid-stream chunk failure returns false but does NOT abort the operation', async () => {
    // Chunk 2 fails (e.g. transient 5xx / network drop). Chunks 1 and 3 succeed.
    apiService.uploadFileBytes = jest
      .fn()
      .mockResolvedValueOnce(true) // chunk 1
      .mockResolvedValueOnce(false) // chunk 2 FAILS
      .mockResolvedValueOnce(true) // chunk 3

    const op = new EncryptAndUploadFileOperation(file, 'api-token', crypto, apiService)

    const r1 = await op.pushBytes(chunkOfSize(50), 1, false)
    const r2 = await op.pushBytes(chunkOfSize(50), 2, false)
    const r3 = await op.pushBytes(chunkOfSize(50), 3, true)

    expect(r1).toBe(true)
    // The failed chunk only reports `false`. There is no throw, no abort signal:
    // the controller's `onChunk` discards this value, so the loop proceeds to chunk 3.
    expect(r2).toBe(false)
    expect(r3).toBe(true)

    // All three chunks were attempted despite the middle failure — proving nothing
    // stops a large multi-chunk upload from continuing past a failed chunk.
    expect(apiService.uploadFileBytes).toHaveBeenCalledTimes(3)
  })

  it('produces a "ghost" FileItem: result size claims ALL pushed bytes while a chunk is missing on the server', async () => {
    apiService.uploadFileBytes = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false) // a chunk never reaches the server
      .mockResolvedValueOnce(true)

    const op = new EncryptAndUploadFileOperation(file, 'api-token', crypto, apiService)

    await op.pushBytes(chunkOfSize(50), 1, false)
    await op.pushBytes(chunkOfSize(50), 2, false) // lost bytes
    await op.pushBytes(chunkOfSize(50), 3, true)

    const result = op.getResult()
    const progress = op.getProgress()

    // The metadata that finishUpload() persists & syncs uses finalDecryptedSize, which
    // counts every PUSHED byte (150) — including the 50 bytes that were never uploaded.
    expect(result.finalDecryptedSize).toBe(150)

    // But the operation's own progress KNOWS only 100 bytes were actually uploaded.
    // The 50-byte gap is the silent data loss. Nothing reconciles result vs. progress,
    // so the synced FileItem advertises a complete 150-byte file whose server bytes are
    // incomplete — and the user is never told.
    expect(progress.decryptedBytesUploaded).toBe(100)
    expect(result.finalDecryptedSize).toBeGreaterThan(progress.decryptedBytesUploaded)
  })
})

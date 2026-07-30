import { FileContent } from '@standardnotes/models'
import { PureCryptoInterface } from '@standardnotes/sncrypto-common'
import { FileDecryptor } from '../UseCase/FileDecryptor'
import { OrderedByteChunker, OrderedByteChunkerError } from '../Chunker/OrderedByteChunker'
import { BackupServiceInterface } from './BackupServiceInterface'
import { OnChunkCallback } from '../Chunker/OnChunkCallback'
import { log, LoggingDomain } from '../Logging'

export async function readAndDecryptBackupFileUsingBackupService(
  file: {
    uuid: string
    encryptionHeader: FileContent['encryptionHeader']
    remoteIdentifier: FileContent['remoteIdentifier']
    encryptedChunkSizes: FileContent['encryptedChunkSizes']
    key: FileContent['key']
  },
  backupService: BackupServiceInterface,
  crypto: PureCryptoInterface,
  onDecryptedBytes: OnChunkCallback,
): Promise<'aborted' | 'failed' | 'success'> {
  log(
    LoggingDomain.FilesPackage,
    'Reading and decrypting backup file',
    file.uuid,
    'chunk sizes',
    file.encryptedChunkSizes,
  )

  let integrityFailed = false
  let authenticatedChunks = 0
  let finalSeen = false

  try {
    const decryptor = new FileDecryptor(file, crypto)
    const byteChunker = new OrderedByteChunker(file.encryptedChunkSizes, 'local', async (chunk) => {
      log(LoggingDomain.FilesPackage, 'OrderedByteChunker did pop bytes', chunk.data.length, chunk.progress)

      if (integrityFailed || finalSeen) {
        integrityFailed = true
        return
      }

      let decryptResult: ReturnType<FileDecryptor['decryptBytes']>
      try {
        decryptResult = decryptor.decryptBytes(chunk.data)
      } catch {
        integrityFailed = true
        return
      }

      if (!decryptResult || decryptResult.isFinalChunk !== chunk.isLast) {
        integrityFailed = true
        return
      }

      authenticatedChunks += 1
      finalSeen = decryptResult.isFinalChunk

      await onDecryptedBytes({ ...chunk, data: decryptResult.decryptedBytes })
    })

    const readResult = await backupService.readEncryptedFileFromBackup(file.uuid, async (chunk) => {
      log(LoggingDomain.FilesPackage, 'Got file chunk from backup service', chunk.data.length, chunk.progress)

      await byteChunker.addBytes(chunk.data)
    })

    if (readResult !== 'success') {
      return readResult
    }

    byteChunker.finish()

    if (integrityFailed || !finalSeen || authenticatedChunks !== file.encryptedChunkSizes.length) {
      return 'failed'
    }

    log(LoggingDomain.FilesPackage, 'Finished reading and decrypting backup file', file.uuid)

    return 'success'
  } catch (error) {
    if (error instanceof OrderedByteChunkerError) {
      return 'failed'
    }

    throw error
  }
}

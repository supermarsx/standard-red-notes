import { FileContent } from '@standardnotes/models'
import { PureCryptoInterface } from '@standardnotes/sncrypto-common'
import { FileDecryptor } from '../UseCase/FileDecryptor'
import { FileSystemApi } from '../Api/FileSystemApi'
import { FileHandleRead } from '../Api/FileHandleRead'
import { OrderedByteChunker, OrderedByteChunkerError } from '../Chunker/OrderedByteChunker'

export async function readAndDecryptBackupFileUsingFileSystemAPI(
  fileHandle: FileHandleRead,
  file: {
    encryptionHeader: FileContent['encryptionHeader']
    remoteIdentifier: FileContent['remoteIdentifier']
    encryptedChunkSizes: FileContent['encryptedChunkSizes']
    key: FileContent['key']
  },
  fileSystem: FileSystemApi,
  crypto: PureCryptoInterface,
  onDecryptedBytes: (decryptedBytes: Uint8Array) => Promise<void>,
): Promise<'aborted' | 'failed' | 'success'> {
  let integrityFailed = false
  let authenticatedChunks = 0
  let finalSeen = false

  try {
    const decryptor = new FileDecryptor(file, crypto)
    const byteChunker = new OrderedByteChunker(file.encryptedChunkSizes, 'local', async (chunk) => {
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

      await onDecryptedBytes(decryptResult.decryptedBytes)
    })

    const readResult = await fileSystem.readFile(fileHandle, async (encryptedBytes: Uint8Array) => {
      await byteChunker.addBytes(encryptedBytes)
    })

    if (readResult !== 'success') {
      return readResult
    }

    byteChunker.finish()

    if (integrityFailed || !finalSeen || authenticatedChunks !== file.encryptedChunkSizes.length) {
      return 'failed'
    }

    return 'success'
  } catch (error) {
    if (error instanceof OrderedByteChunkerError) {
      return 'failed'
    }

    throw error
  }
}

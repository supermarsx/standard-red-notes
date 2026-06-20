import { FileContent } from '@standardnotes/models'
import { PureCryptoInterface } from '@standardnotes/sncrypto-common'

import { FileEncryptor } from '../UseCase/FileEncryptor'
import { EncryptedBytes } from '../Types/EncryptedBytes'

/**
 * Mirror of {@link EncryptAndUploadFileOperation} for "large local-only files": it E2E-encrypts
 * pushed chunks exactly the same way (xchacha20 stream) but, instead of uploading each chunk to
 * the server, it accumulates the encrypted bytes in memory so they can be persisted to a local
 * (IndexedDB) backend. No network calls are made.
 *
 * NOTE: accumulating the full encrypted payload in memory means a transient in-tab copy of the
 * file's encrypted bytes (plus the plaintext chunk being encrypted). For very large files this
 * is the dominant memory cost — see the stability notes.
 */
export class LocalOnlyFileUploadOperation {
  public readonly encryptedChunkSizes: number[] = []

  private readonly encryptor: FileEncryptor
  private readonly encryptionHeader: string

  private chunks: Uint8Array[] = []
  private totalEncryptedSize = 0
  private totalBytesPushedInDecryptedTerms = 0

  constructor(
    private file: {
      decryptedSize: FileContent['decryptedSize']
      key: FileContent['key']
      remoteIdentifier: FileContent['remoteIdentifier']
    },
    crypto: PureCryptoInterface,
  ) {
    this.encryptor = new FileEncryptor(file, crypto)
    this.encryptionHeader = this.encryptor.initializeHeader()
  }

  public get decryptedSize(): number {
    return this.totalBytesPushedInDecryptedTerms
  }

  public pushBytes(decryptedBytes: Uint8Array, isFinalChunk: boolean): void {
    this.totalBytesPushedInDecryptedTerms += decryptedBytes.byteLength

    const encryptedBytes = this.encryptor.pushBytes(decryptedBytes, isFinalChunk)

    this.encryptedChunkSizes.push(encryptedBytes.length)
    this.totalEncryptedSize += encryptedBytes.length
    this.chunks.push(encryptedBytes)
  }

  /** Concatenates the accumulated encrypted chunks into a single byte payload. */
  public getEncryptedBytes(): EncryptedBytes {
    const aggregate = new Uint8Array(this.totalEncryptedSize)
    let offset = 0
    for (const chunk of this.chunks) {
      aggregate.set(chunk, offset)
      offset += chunk.length
    }
    return { encryptedBytes: aggregate }
  }

  public getResult(): {
    encryptionHeader: string
    finalDecryptedSize: number
    key: string
    remoteIdentifier: string
  } {
    return {
      encryptionHeader: this.encryptionHeader,
      finalDecryptedSize: this.totalBytesPushedInDecryptedTerms,
      key: this.file.key,
      remoteIdentifier: this.file.remoteIdentifier,
    }
  }
}

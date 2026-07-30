import { FileDownloadProgress } from '../Types/FileDownloadProgress'
import { OnChunkCallback } from './OnChunkCallback'

export class OrderedByteChunkerError extends Error {}

export class OrderedByteChunker {
  private bytes = new Uint8Array()
  private index = 1
  private remainingChunks: number[] = []
  private fileSize: number
  private readonly chunkSizes: number[]

  constructor(
    chunkSizes: number[],
    private source: FileDownloadProgress['source'],
    private onChunk: OnChunkCallback,
  ) {
    if (chunkSizes.length === 0) {
      throw new OrderedByteChunkerError('Encrypted file metadata does not contain any chunks.')
    }

    let fileSize = 0
    for (const size of chunkSizes) {
      if (!Number.isSafeInteger(size) || size <= 0) {
        throw new OrderedByteChunkerError('Encrypted file metadata contains an invalid chunk size.')
      }

      fileSize += size
      if (!Number.isSafeInteger(fileSize)) {
        throw new OrderedByteChunkerError('Encrypted file metadata exceeds the supported size.')
      }
    }

    this.chunkSizes = chunkSizes.slice()
    this.remainingChunks = this.chunkSizes.slice()
    this.fileSize = fileSize
  }

  private get bytesPopped(): number {
    return this.fileSize - this.bytesRemaining
  }

  private get bytesRemaining(): number {
    return this.remainingChunks.reduce((acc, size) => acc + size, 0)
  }

  private needsPop(): boolean {
    return this.remainingChunks.length > 0 && this.bytes.length >= this.remainingChunks[0]
  }

  public async addBytes(bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength === 0) {
      return
    }

    if (this.remainingChunks.length === 0) {
      throw new OrderedByteChunkerError('Encrypted file contains data after its declared final chunk.')
    }
    if (bytes.byteLength > this.bytesRemaining - this.bytes.byteLength) {
      throw new OrderedByteChunkerError('Encrypted file contains more data than its declared chunk metadata.')
    }

    const aggregate = new Uint8Array(this.bytes.byteLength + bytes.byteLength)
    aggregate.set(this.bytes)
    aggregate.set(bytes, this.bytes.byteLength)
    this.bytes = aggregate

    while (this.needsPop()) {
      await this.popBytes()
    }
  }

  private async popBytes(): Promise<void> {
    const readUntil = this.remainingChunks[0]

    const chunk = this.bytes.slice(0, readUntil)

    this.bytes = this.bytes.slice(readUntil)

    this.remainingChunks.shift()
    const chunkIndex = this.index++

    await this.onChunk({
      data: chunk,
      index: chunkIndex,
      isLast: this.remainingChunks.length === 0,
      progress: {
        encryptedFileSize: this.fileSize,
        encryptedBytesDownloaded: this.bytesPopped,
        encryptedBytesRemaining: this.bytesRemaining,
        percentComplete: (this.bytesPopped / this.fileSize) * 100.0,
        source: this.source,
      },
    })
  }

  public finish(): void {
    if (this.remainingChunks.length !== 0 || this.bytes.byteLength !== 0) {
      throw new OrderedByteChunkerError(
        `Encrypted file ended after ${this.chunkSizes.length - this.remainingChunks.length} of ${
          this.chunkSizes.length
        } declared chunks.`,
      )
    }
  }
}

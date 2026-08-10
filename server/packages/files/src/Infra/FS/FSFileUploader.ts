import { createHash, randomUUID } from 'crypto'
import { createReadStream, fsync, promises } from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { Readable } from 'stream'
import { inject, injectable } from 'inversify'
import { Logger } from 'winston'

import { FileUploaderInterface } from '../../Domain/Services/FileUploaderInterface'
import { UploadChunkResult } from '../../Domain/Upload/UploadChunkResult'
import TYPES from '../../Bootstrap/Types'
import { ChunkId } from '../../Domain/Upload/ChunkId'

export interface FSUploadFileHandle {
  readonly fd: number
  writeFile(data: Uint8Array): Promise<void>
  close(): Promise<void>
}

export interface FSFileUploadOperations {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>
  open(path: string, flags: 'wx', mode: number): Promise<FSUploadFileHandle>
  sync(fileHandle: FSUploadFileHandle): Promise<void>
  syncDirectory(path: string): Promise<void>
  link(existingPath: string, newPath: string): Promise<void>
  rm(path: string, options: { force: true }): Promise<void>
  stat(path: string): Promise<{ size: number }>
  createReadStream(path: string): Readable
}

const syncFileDescriptor = (fileDescriptor: number): Promise<void> =>
  new Promise((resolveSync, reject) => {
    fsync(fileDescriptor, (error) => (error ? reject(error) : resolveSync()))
  })

const nodeFileOperations: FSFileUploadOperations = {
  mkdir: (path, options) => promises.mkdir(path, options),
  open: (path, flags, mode) => promises.open(path, flags, mode),
  sync: (fileHandle) => syncFileDescriptor(fileHandle.fd),
  syncDirectory: async (path) => {
    const directoryHandle = await promises.open(path, 'r')
    try {
      await syncFileDescriptor(directoryHandle.fd)
    } finally {
      await directoryHandle.close()
    }
  },
  link: (existingPath, newPath) => promises.link(existingPath, newPath),
  rm: (path, options) => promises.rm(path, options),
  stat: (path) => promises.stat(path),
  createReadStream: (path) => createReadStream(path),
}

type UploadManifest = {
  signature: string
  totalSize: number
  orderedResults: UploadChunkResult[]
}

type CompletedUpload = {
  digest: string
  filePath: string
  manifestSignature: string
  totalSize: number
}

@injectable()
export class FSFileUploader implements FileUploaderInterface {
  private readonly maximumRememberedCompletions = 1_024
  private inMemoryChunks: Map<string, Map<number, Uint8Array>>
  private completedUploads: Map<string, CompletedUpload>

  constructor(
    @inject(TYPES.Files_FILE_UPLOAD_PATH) private fileUploadPath: string,
    @inject(TYPES.Files_Logger) private logger: Logger,
    private generateUuid: () => string = randomUUID,
    private fileOperations: FSFileUploadOperations = nodeFileOperations,
  ) {
    this.inMemoryChunks = new Map<string, Map<number, Uint8Array>>()
    this.completedUploads = new Map<string, CompletedUpload>()
  }

  async uploadFileChunk(dto: {
    uploadId: string
    data: Uint8Array
    filePath: string
    chunkId: ChunkId
    unencryptedFileSize: number
  }): Promise<string> {
    if (!Number.isSafeInteger(dto.chunkId) || dto.chunkId < 1) {
      throw new Error(`Could not upload file chunk. Invalid chunk id ${dto.chunkId}`)
    }
    if (dto.data.byteLength === 0) {
      throw new Error(`Could not upload empty file chunk ${dto.chunkId}`)
    }

    if (!this.inMemoryChunks.has(dto.uploadId)) {
      this.inMemoryChunks.set(dto.uploadId, new Map<number, Uint8Array>())
    }

    const fileChunks = this.inMemoryChunks.get(dto.uploadId) as Map<number, Uint8Array>

    const alreadyStoredBytes = this.accumulatedEncryptedFileSize(fileChunks)
    if (alreadyStoredBytes >= dto.unencryptedFileSize) {
      throw new Error(
        `Could not finish chunk upload. Accumulated encrypted file size (${alreadyStoredBytes}B) already exceeds the unecrypted file size: ${dto.unencryptedFileSize}`,
      )
    }

    this.logger.debug(`FS buffering file chunk ${dto.chunkId} for ${dto.uploadId} (${dto.data.byteLength} bytes)`)

    fileChunks.set(dto.chunkId, dto.data)

    return dto.uploadId
  }

  async finishUploadSession(
    uploadId: string,
    filePath: string,
    uploadChunkResults: UploadChunkResult[],
  ): Promise<void> {
    this.logger.debug(`FS finishing upload for ${uploadId}`)

    const destinationPath = this.resolveDestinationPath(filePath)
    const manifest = this.validateManifest(uploadChunkResults)
    const fileChunks = this.inMemoryChunks.get(uploadId)

    if (!fileChunks) {
      await this.verifyRememberedCompletion(uploadId, destinationPath, manifest)
      return
    }

    const { digest, totalSize } = this.validateChunksAndComputeDigest(fileChunks, manifest)
    const destinationDirectory = dirname(destinationPath)
    const temporaryPath = join(destinationDirectory, `.${basename(destinationPath)}.${this.generateUuid()}.partial`)
    let fileHandle: FSUploadFileHandle | undefined
    let temporaryFileCreated = false
    let operationFailed = false

    try {
      await this.fileOperations.mkdir(destinationDirectory, { recursive: true })
      fileHandle = await this.fileOperations.open(temporaryPath, 'wx', 0o600)
      temporaryFileCreated = true

      for (const result of manifest.orderedResults) {
        await fileHandle.writeFile(fileChunks.get(result.chunkId) as Uint8Array)
      }

      await this.fileOperations.sync(fileHandle)
      await fileHandle.close()
      fileHandle = undefined

      try {
        // Publishing via a hard link is atomic and refuses to replace an
        // existing destination. The attempt-owned temporary path stays in the
        // same directory, so publication cannot cross filesystems.
        await this.fileOperations.link(temporaryPath, destinationPath)
      } catch (error) {
        if (!this.isAlreadyExistsError(error)) {
          throw error
        }

        await this.assertExistingFileMatches(destinationPath, totalSize, digest)
      }

      // The hard link publishes the file atomically; syncing the containing
      // directory makes that new directory entry durable on Linux filesystems.
      await this.fileOperations.syncDirectory(destinationDirectory)

      this.rememberCompletedUpload(uploadId, {
        digest,
        filePath: destinationPath,
        manifestSignature: manifest.signature,
        totalSize,
      })
      this.inMemoryChunks.delete(uploadId)
    } catch (error) {
      operationFailed = true
      throw error
    } finally {
      const cleanupErrors: unknown[] = []

      if (fileHandle) {
        try {
          await fileHandle.close()
        } catch (error) {
          cleanupErrors.push(error)
        }
      }

      if (temporaryFileCreated) {
        try {
          await this.fileOperations.rm(temporaryPath, { force: true })
        } catch (error) {
          cleanupErrors.push(error)
        }
      }

      if (cleanupErrors.length > 0) {
        if (operationFailed) {
          this.logger.error('FS upload cleanup failed after the upload operation had already failed', {
            errors: cleanupErrors,
            uploadId,
          })
        } else {
          throw cleanupErrors[0]
        }
      }
    }
  }

  async createUploadSession(filePath: string): Promise<string> {
    const fullPath = this.resolveDestinationPath(filePath)

    await this.fileOperations.mkdir(dirname(fullPath), { recursive: true })

    return fullPath
  }

  async abortUploadSession(uploadId: string, _filePath: string): Promise<void> {
    // Discard only buffered chunks. finishUploadSession owns and cleans its
    // unique temporary artifact, and a published destination must never be
    // removed by an abort racing a completed finish.
    this.inMemoryChunks.delete(uploadId)
  }

  private validateManifest(uploadChunkResults: UploadChunkResult[]): UploadManifest {
    if (uploadChunkResults.length === 0) {
      throw new Error('Could not finish upload without chunk results')
    }

    const orderedResults = [...uploadChunkResults].sort((a, b) => a.chunkId - b.chunkId)
    let totalSize = 0

    for (let index = 0; index < orderedResults.length; index++) {
      const result = orderedResults[index]
      const expectedChunkId = index + 1

      if (!Number.isSafeInteger(result.chunkId) || result.chunkId !== expectedChunkId) {
        throw new Error(`Could not finish upload. Expected chunk ${expectedChunkId}, received ${result.chunkId}`)
      }
      if (!Number.isSafeInteger(result.chunkSize) || result.chunkSize <= 0) {
        throw new Error(`Could not finish upload. Chunk ${result.chunkId} has an invalid size`)
      }

      totalSize += result.chunkSize
      if (!Number.isSafeInteger(totalSize)) {
        throw new Error('Could not finish upload. Total encrypted file size is invalid')
      }
    }

    return {
      signature: orderedResults.map((result) => `${result.chunkId}:${result.chunkSize}`).join(','),
      totalSize,
      orderedResults,
    }
  }

  private validateChunksAndComputeDigest(
    fileChunks: Map<number, Uint8Array>,
    manifest: UploadManifest,
  ): { digest: string; totalSize: number } {
    if (fileChunks.size !== manifest.orderedResults.length) {
      throw new Error(
        `Could not finish upload. Expected ${manifest.orderedResults.length} chunks, received ${fileChunks.size}`,
      )
    }

    const hash = createHash('sha256')
    let totalSize = 0

    for (const result of manifest.orderedResults) {
      const chunk = fileChunks.get(result.chunkId)
      if (!chunk || chunk.byteLength !== result.chunkSize) {
        throw new Error(`Could not finish upload. Chunk ${result.chunkId} is missing or has an unexpected size`)
      }

      hash.update(chunk)
      totalSize += chunk.byteLength
    }

    if (totalSize !== manifest.totalSize) {
      throw new Error('Could not finish upload. Buffered bytes do not match the upload manifest')
    }

    return { digest: hash.digest('hex'), totalSize }
  }

  private async verifyRememberedCompletion(
    uploadId: string,
    destinationPath: string,
    manifest: UploadManifest,
  ): Promise<void> {
    const completed = this.completedUploads.get(uploadId)
    if (
      !completed ||
      completed.filePath !== destinationPath ||
      completed.manifestSignature !== manifest.signature ||
      completed.totalSize !== manifest.totalSize
    ) {
      throw new Error(`Could not find chunks for upload ${uploadId}`)
    }

    await this.assertExistingFileMatches(destinationPath, completed.totalSize, completed.digest)
  }

  private async assertExistingFileMatches(destinationPath: string, expectedSize: number, expectedDigest: string) {
    const stats = await this.fileOperations.stat(destinationPath)
    if (stats.size !== expectedSize) {
      throw new Error(`Refusing to replace existing file ${destinationPath}: content differs from completed upload`)
    }

    const hash = createHash('sha256')
    for await (const chunk of this.fileOperations.createReadStream(destinationPath)) {
      hash.update(chunk as Buffer)
    }

    if (hash.digest('hex') !== expectedDigest) {
      throw new Error(`Refusing to replace existing file ${destinationPath}: content differs from completed upload`)
    }
  }

  private rememberCompletedUpload(uploadId: string, completed: CompletedUpload): void {
    this.completedUploads.delete(uploadId)
    this.completedUploads.set(uploadId, completed)

    while (this.completedUploads.size > this.maximumRememberedCompletions) {
      const oldestUploadId = this.completedUploads.keys().next().value as string | undefined
      if (oldestUploadId === undefined) {
        return
      }
      this.completedUploads.delete(oldestUploadId)
    }
  }

  private isAlreadyExistsError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'EEXIST'
    )
  }

  private resolveDestinationPath(filePath: string): string {
    const uploadRoot = resolve(this.fileUploadPath)
    const destinationPath = resolve(uploadRoot, filePath)
    const relativePath = relative(uploadRoot, destinationPath)

    if (
      relativePath === '' ||
      relativePath === '..' ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      throw new Error(`Refusing upload path outside the configured file upload directory: ${filePath}`)
    }

    return destinationPath
  }

  private accumulatedEncryptedFileSize(fileChunks: Map<number, Uint8Array>): number {
    let accumulatedSize = 0

    for (const value of fileChunks.values()) {
      accumulatedSize += value.byteLength
    }

    return accumulatedSize
  }
}

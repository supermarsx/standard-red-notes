import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { constants, promises, type Stats } from 'fs'
import type { FileHandle } from 'fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'path'

import {
  BackupAttachmentAlreadyDeliveredError,
  BackupAttachmentChangedDuringReadError,
  BackupAttachmentNotFoundError,
  BackupAttachmentReference,
  BackupAttachmentStorageInterface,
  BackupAttachmentTooLargeError,
  InvalidBackupAttachmentReferenceError,
} from '../../Domain/Email/BackupAttachmentStorageInterface'

export interface BackupAttachmentFileOperations {
  lstat(path: string): Promise<Stats>
  realpath(path: string): Promise<string>
  open(path: string, flags: number): Promise<FileHandle>
  rename(oldPath: string, newPath: string): Promise<void>
  unlink(path: string): Promise<void>
}

const nodeFileOperations: BackupAttachmentFileOperations = {
  lstat: (path) => promises.lstat(path),
  realpath: (path) => promises.realpath(path),
  open: (path, flags) => promises.open(path, flags),
  rename: (oldPath, newPath) => promises.rename(oldPath, newPath),
  unlink: (path) => promises.unlink(path),
}

type ResolvedAttachment =
  | {
      type: 'fs'
      path: string
      root: string
    }
  | {
      type: 's3'
      bucket: string
      key: string
    }

export class FSOrS3BackupAttachmentStorage implements BackupAttachmentStorageInterface {
  constructor(
    private fileUploadPath?: string,
    private s3BackupBucketName?: string,
    private s3Client?: S3Client,
    private maxByteSize = 10_485_760,
    private fileOperations: BackupAttachmentFileOperations = nodeFileOperations,
  ) {
    if (!Number.isSafeInteger(maxByteSize) || maxByteSize <= 0) {
      throw new RangeError('Backup attachment byte limit must be a positive safe integer')
    }
  }

  async read(reference: BackupAttachmentReference): Promise<Buffer> {
    const resolved = this.resolveReference(reference)

    if (resolved.type === 's3') {
      if (await this.s3ReceiptExists(resolved.bucket, resolved.key)) {
        throw new BackupAttachmentAlreadyDeliveredError()
      }

      return this.readS3(resolved.bucket, resolved.key)
    }

    if (await this.localReceiptExists(resolved.path)) {
      throw new BackupAttachmentAlreadyDeliveredError()
    }

    return this.readFile(resolved.root, resolved.path)
  }

  async markDelivered(reference: BackupAttachmentReference): Promise<void> {
    const resolved = this.resolveReference(reference)

    if (resolved.type === 's3') {
      await (this.s3Client as S3Client).send(
        new PutObjectCommand({
          Bucket: resolved.bucket,
          Key: this.receiptName(resolved.key),
          Body: '',
          ContentType: 'application/x-standard-notes-delivery-receipt',
        }),
      )
      await (this.s3Client as S3Client).send(
        new DeleteObjectCommand({
          Bucket: resolved.bucket,
          Key: resolved.key,
        }),
      )

      return
    }

    const receiptPath = this.receiptName(resolved.path)
    if (await this.localReceiptExists(resolved.path)) {
      return
    }

    try {
      await this.fileOperations.rename(resolved.path, receiptPath)
    } catch (error) {
      if (this.isMissingError(error) && (await this.localReceiptExists(resolved.path))) {
        return
      }
      if (this.isMissingError(error)) {
        throw new BackupAttachmentNotFoundError()
      }

      throw error
    }
  }

  async delete(reference: BackupAttachmentReference): Promise<void> {
    const resolved = this.resolveReference(reference)

    if (resolved.type === 's3') {
      await Promise.all([
        (this.s3Client as S3Client).send(
          new DeleteObjectCommand({
            Bucket: resolved.bucket,
            Key: resolved.key,
          }),
        ),
        (this.s3Client as S3Client).send(
          new DeleteObjectCommand({
            Bucket: resolved.bucket,
            Key: this.receiptName(resolved.key),
          }),
        ),
      ])

      return
    }

    await Promise.all([this.deleteLocalPath(resolved.path), this.deleteLocalPath(this.receiptName(resolved.path))])
  }

  private async deleteLocalPath(path: string): Promise<void> {
    try {
      await this.fileOperations.unlink(path)
    } catch (error) {
      if (!this.isMissingError(error)) {
        throw error
      }
    }
  }

  private resolveReference(reference: BackupAttachmentReference): ResolvedAttachment {
    if (
      typeof reference?.fileName !== 'string' ||
      typeof reference.filePath !== 'string' ||
      !this.isSafeFileName(reference.fileName)
    ) {
      throw new InvalidBackupAttachmentReferenceError()
    }

    const configuredBucket = this.s3BackupBucketName?.trim()
    if (configuredBucket && reference.filePath === configuredBucket) {
      if (!this.s3Client) {
        throw new Error('S3 backup attachment storage is not configured')
      }

      return {
        type: 's3',
        bucket: configuredBucket,
        key: reference.fileName,
      }
    }

    const configuredUploadPath = this.fileUploadPath?.trim()
    if (!configuredUploadPath) {
      throw new InvalidBackupAttachmentReferenceError()
    }

    const root = resolve(configuredUploadPath, 'backups')
    if (!isAbsolute(reference.filePath) || resolve(reference.filePath) !== root) {
      throw new InvalidBackupAttachmentReferenceError()
    }

    const path = resolve(root, reference.fileName)
    const relativePath = relative(root, path)
    if (!relativePath || dirname(relativePath) !== '.' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new InvalidBackupAttachmentReferenceError()
    }

    return {
      type: 'fs',
      path,
      root,
    }
  }

  private async readFile(root: string, path: string): Promise<Buffer> {
    try {
      const stats = await this.fileOperations.lstat(path)
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new InvalidBackupAttachmentReferenceError()
      }
      if (stats.size > this.maxByteSize) {
        throw new BackupAttachmentTooLargeError()
      }

      const [realRoot, realPath] = await Promise.all([
        this.fileOperations.realpath(root),
        this.fileOperations.realpath(path),
      ])
      if (dirname(realPath) !== realRoot) {
        throw new InvalidBackupAttachmentReferenceError()
      }

      const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0
      const handle = await this.fileOperations.open(realPath, constants.O_RDONLY | noFollow)
      try {
        const openStats = await handle.stat()
        if (!openStats.isFile()) {
          throw new InvalidBackupAttachmentReferenceError()
        }
        if (openStats.size > this.maxByteSize) {
          throw new BackupAttachmentTooLargeError()
        }
        if (
          openStats.size !== stats.size ||
          openStats.dev !== stats.dev ||
          openStats.ino !== stats.ino ||
          openStats.mtimeMs !== stats.mtimeMs ||
          openStats.ctimeMs !== stats.ctimeMs
        ) {
          throw new BackupAttachmentChangedDuringReadError()
        }

        const content = Buffer.alloc(openStats.size)
        let offset = 0
        while (offset < content.length) {
          const { bytesRead } = await handle.read(content, offset, content.length - offset, offset)
          if (bytesRead === 0) {
            break
          }
          offset += bytesRead
        }

        const finalStats = await handle.stat()
        if (
          offset !== openStats.size ||
          finalStats.size !== openStats.size ||
          finalStats.mtimeMs !== openStats.mtimeMs ||
          finalStats.ctimeMs !== openStats.ctimeMs
        ) {
          throw new BackupAttachmentChangedDuringReadError()
        }

        return content.subarray(0, offset)
      } finally {
        await handle.close()
      }
    } catch (error) {
      if (this.isMissingError(error)) {
        throw new BackupAttachmentNotFoundError()
      }

      throw error
    }
  }

  private async localReceiptExists(path: string): Promise<boolean> {
    try {
      const stats = await this.fileOperations.lstat(this.receiptName(path))
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new InvalidBackupAttachmentReferenceError()
      }

      return true
    } catch (error) {
      if (this.isMissingError(error)) {
        return false
      }

      throw error
    }
  }

  private async s3ReceiptExists(bucket: string, key: string): Promise<boolean> {
    try {
      await (this.s3Client as S3Client).send(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: this.receiptName(key),
        }),
      )

      return true
    } catch (error) {
      if (this.isMissingError(error)) {
        return false
      }

      throw error
    }
  }

  private async readS3(bucket: string, key: string): Promise<Buffer> {
    try {
      const response = await (this.s3Client as S3Client).send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          // Read at most max + 1 bytes. The sentinel byte lets us reject an
          // oversized object without ever buffering the full object.
          Range: `bytes=0-${this.maxByteSize}`,
        }),
      )

      if (!response.Body) {
        throw new BackupAttachmentNotFoundError()
      }

      return this.readBoundedS3Body(response.Body)
    } catch (error) {
      if (error instanceof BackupAttachmentNotFoundError) {
        throw error
      }
      if (this.isMissingError(error)) {
        throw new BackupAttachmentNotFoundError()
      }

      throw error
    }
  }

  private async readBoundedS3Body(body: object): Promise<Buffer> {
    const stream = body as AsyncIterable<Uint8Array> & { destroy?: () => void }
    if (typeof stream[Symbol.asyncIterator] !== 'function') {
      throw new Error('S3 backup attachment body is not streamable')
    }

    const chunks: Buffer[] = []
    let totalByteSize = 0
    for await (const chunk of stream) {
      const buffer = Buffer.from(chunk)
      totalByteSize += buffer.length
      if (totalByteSize > this.maxByteSize) {
        stream.destroy?.()
        throw new BackupAttachmentTooLargeError()
      }
      chunks.push(buffer)
    }

    return Buffer.concat(chunks, totalByteSize)
  }

  private isSafeFileName(fileName: string): boolean {
    return (
      fileName.length > 0 &&
      fileName.length <= 255 &&
      basename(fileName) === fileName &&
      !fileName.includes('..') &&
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(fileName)
    )
  }

  private receiptName(fileNameOrPath: string): string {
    return `${fileNameOrPath}.delivered`
  }

  private isMissingError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false
    }

    const candidate = error as {
      code?: string
      name?: string
      $metadata?: { httpStatusCode?: number }
    }

    return (
      candidate.code === 'ENOENT' ||
      candidate.name === 'NoSuchKey' ||
      candidate.name === 'NotFound' ||
      candidate.$metadata?.httpStatusCode === 404
    )
  }
}

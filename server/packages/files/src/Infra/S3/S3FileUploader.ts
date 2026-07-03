import { inject, injectable } from 'inversify'
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'

import TYPES from '../../Bootstrap/Types'
import { FileUploaderInterface } from '../../Domain/Services/FileUploaderInterface'
import { UploadId } from '../../Domain/Upload/UploadId'
import { UploadChunkResult } from '../../Domain/Upload/UploadChunkResult'
import { ChunkId } from '../../Domain/Upload/ChunkId'

@injectable()
export class S3FileUploader implements FileUploaderInterface {
  // Running byte total per upload session (keyed by chunk id so retries of the
  // same chunk overwrite instead of double-counting), used to enforce the
  // authorized unencryptedFileSize during upload — mirroring FSFileUploader.
  private chunkSizesByUploadId: Map<string, Map<number, number>>

  constructor(
    @inject(TYPES.Files_S3) private s3Client: S3Client,
    @inject(TYPES.Files_S3_BUCKET_NAME) private s3BuckeName: string,
  ) {
    this.chunkSizesByUploadId = new Map<string, Map<number, number>>()
  }

  async createUploadSession(filePath: string): Promise<UploadId> {
    const uploadSessionCreationResult = await this.s3Client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.s3BuckeName,
        Key: filePath,
        ACL: 'private',
        StorageClass: 'INTELLIGENT_TIERING',
      }),
    )

    return uploadSessionCreationResult.UploadId as string
  }

  async uploadFileChunk(dto: {
    uploadId: string
    data: Uint8Array
    filePath: string
    chunkId: ChunkId
    unencryptedFileSize: number
  }): Promise<string> {
    if (!this.chunkSizesByUploadId.has(dto.uploadId)) {
      this.chunkSizesByUploadId.set(dto.uploadId, new Map<number, number>())
    }
    const chunkSizes = this.chunkSizesByUploadId.get(dto.uploadId) as Map<number, number>

    // Enforce the authorized unencrypted file size while uploading, so a client
    // cannot stream more bytes than the valet token permitted (S3 previously
    // enforced this only at finish, after the parts were already uploaded).
    const alreadyStoredBytes = this.accumulatedSize(chunkSizes)
    if (alreadyStoredBytes >= dto.unencryptedFileSize) {
      throw new Error(
        `Could not upload file chunk. Accumulated encrypted file size (${alreadyStoredBytes}B) already exceeds the unencrypted file size: ${dto.unencryptedFileSize}`,
      )
    }

    const uploadResult = await this.s3Client.send(
      new UploadPartCommand({
        Body: dto.data,
        Bucket: this.s3BuckeName,
        Key: dto.filePath,
        PartNumber: dto.chunkId,
        UploadId: dto.uploadId,
      }),
    )

    chunkSizes.set(dto.chunkId, dto.data.byteLength)

    return uploadResult.ETag as string
  }

  async finishUploadSession(
    uploadId: string,
    filePath: string,
    uploadChunkResults: UploadChunkResult[],
  ): Promise<void> {
    const multipartUploadParts = uploadChunkResults.map((uploadChunkResult) => ({
      ETag: uploadChunkResult.tag,
      PartNumber: uploadChunkResult.chunkId,
    }))

    try {
      await this.s3Client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.s3BuckeName,
          Key: filePath,
          MultipartUpload: {
            Parts: multipartUploadParts,
          },
          UploadId: uploadId,
        }),
      )
    } catch (error) {
      // Completing failed — abort so the already-uploaded parts are not left
      // orphaned in the bucket (S3 bills for incomplete multipart uploads).
      await this.safelyAbort(uploadId, filePath)

      throw error
    } finally {
      this.chunkSizesByUploadId.delete(uploadId)
    }
  }

  async abortUploadSession(uploadId: string, filePath: string): Promise<void> {
    this.chunkSizesByUploadId.delete(uploadId)

    await this.s3Client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.s3BuckeName,
        Key: filePath,
        UploadId: uploadId,
      }),
    )
  }

  private async safelyAbort(uploadId: string, filePath: string): Promise<void> {
    try {
      await this.s3Client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.s3BuckeName,
          Key: filePath,
          UploadId: uploadId,
        }),
      )
    } catch (_error) {
      // Best-effort cleanup; never mask the original failure.
    }
  }

  private accumulatedSize(chunkSizes: Map<number, number>): number {
    let total = 0
    for (const size of chunkSizes.values()) {
      total += size
    }

    return total
  }
}

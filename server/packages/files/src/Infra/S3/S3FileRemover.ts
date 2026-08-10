import { inject, injectable } from 'inversify'
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  S3Client,
} from '@aws-sdk/client-s3'

import TYPES from '../../Bootstrap/Types'
import { FileRemoverInterface } from '../../Domain/Services/FileRemoverInterface'
import { RemovedFileDescription } from '../../Domain/File/RemovedFileDescription'

@injectable()
export class S3FileRemover implements FileRemoverInterface {
  constructor(
    @inject(TYPES.Files_S3) private s3Client: S3Client,
    @inject(TYPES.Files_S3_BUCKET_NAME) private s3BuckeName: string,
  ) {}

  async markFilesToBeRemoved(userUuid: string): Promise<Array<RemovedFileDescription>> {
    const fileDescriptionsByPath = new Map<string, RemovedFileDescription>()
    const continuationTokens = new Set<string>()
    const prefix = `${userUuid}/`
    let continuationToken: string | undefined

    do {
      const filesResponse: ListObjectsV2CommandOutput = await this.s3Client.send(
        new ListObjectsV2Command({
          Bucket: this.s3BuckeName,
          Prefix: prefix,
          ...(continuationToken === undefined ? {} : { ContinuationToken: continuationToken }),
        }),
      )

      const nextContinuationToken = this.getNextContinuationToken(filesResponse, continuationTokens)
      for (const file of filesResponse.Contents ?? []) {
        if (file.Key === undefined || fileDescriptionsByPath.has(file.Key)) {
          continue
        }

        fileDescriptionsByPath.set(file.Key, {
          fileByteSize: file.Size as number,
          fileName: file.Key.replace(prefix, ''),
          filePath: file.Key,
          userOrSharedVaultUuid: userUuid,
        })
      }

      continuationToken = nextContinuationToken
    } while (continuationToken !== undefined)

    const fileDescriptions = [...fileDescriptionsByPath.values()]

    for (const file of fileDescriptions) {
      await this.s3Client.send(
        new CopyObjectCommand({
          Bucket: this.s3BuckeName,
          Key: `expiration-chamber/${file.filePath}`,
          CopySource: `${this.s3BuckeName}/${file.filePath}`,
          StorageClass: 'DEEP_ARCHIVE',
        }),
      )
    }

    for (const file of fileDescriptions) {
      await this.s3Client.send(
        new DeleteObjectCommand({
          Bucket: this.s3BuckeName,
          Key: file.filePath,
        }),
      )
    }

    return fileDescriptions
  }

  private getNextContinuationToken(
    filesResponse: ListObjectsV2CommandOutput,
    continuationTokens: Set<string>,
  ): string | undefined {
    if (filesResponse.IsTruncated !== true) {
      return undefined
    }

    const nextContinuationToken = filesResponse.NextContinuationToken

    if (!nextContinuationToken || continuationTokens.has(nextContinuationToken)) {
      throw new Error('Could not completely list files marked for removal')
    }

    continuationTokens.add(nextContinuationToken)

    return nextContinuationToken
  }

  async remove(filePath: string): Promise<number> {
    const head = await this.s3Client.send(
      new HeadObjectCommand({
        Bucket: this.s3BuckeName,
        Key: filePath,
      }),
    )

    const fileSize = head.ContentLength as number

    await this.s3Client.send(
      new DeleteObjectCommand({
        Bucket: this.s3BuckeName,
        Key: filePath,
      }),
    )

    return fileSize
  }
}

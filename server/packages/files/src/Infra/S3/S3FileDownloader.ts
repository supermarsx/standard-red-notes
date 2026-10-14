import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { inject, injectable } from 'inversify'
import { Readable } from 'stream'

import TYPES from '../../Bootstrap/Types'
import { FileDownloaderInterface } from '../../Domain/Services/FileDownloaderInterface'

@injectable()
export class S3FileDownloader implements FileDownloaderInterface {
  constructor(
    @inject(TYPES.Files_S3) private s3Client: S3Client,
    @inject(TYPES.Files_S3_BUCKET_NAME) private s3BuckeName: string,
  ) {}

  async createDownloadStream(
    filePath: string,
    startRange: number,
    endRange: number,
    abortSignal?: AbortSignal,
  ): Promise<Readable> {
    const commandResult = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: this.s3BuckeName,
        Key: filePath,
        Range: `bytes=${startRange}-${endRange}`,
      }),
      { abortSignal },
    )

    return commandResult.Body as Readable
  }

  async getFileSize(filePath: string, abortSignal?: AbortSignal): Promise<number> {
    const head = await this.s3Client.send(
      new HeadObjectCommand({
        Bucket: this.s3BuckeName,
        Key: filePath,
      }),
      { abortSignal },
    )

    return head.ContentLength as number
  }

  async listFiles(userUuid: string): Promise<{ name: string; size: number }[]> {
    const filesList: { name: string; size: number }[] = []
    let continuationToken: string | undefined
    const seenTokens = new Set<string>()
    do {
      const objectsList = await this.s3Client.send(
        new ListObjectsV2Command({
          Bucket: this.s3BuckeName,
          Prefix: `${userUuid}/`,
          ContinuationToken: continuationToken,
        }),
      )
      for (const object of objectsList.Contents ?? []) {
        if (!object.Key || object.Key.endsWith('/') || !object.Key.startsWith(`${userUuid}/`)) {
          continue
        }
        if (typeof object.Size !== 'number' || !Number.isSafeInteger(object.Size) || object.Size < 0) {
          throw new Error('File size unavailable')
        }
        filesList.push({ name: object.Key, size: object.Size })
      }
      if (!objectsList.IsTruncated) {
        break
      }
      const next = objectsList.NextContinuationToken
      if (!next || seenTokens.has(next)) {
        throw new Error('Incomplete file listing')
      }
      seenTokens.add(next)
      continuationToken = next
    } while (true)
    return filesList
  }
}

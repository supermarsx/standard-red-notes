import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3'

import { StorageReadinessInterface } from '../../Domain/Services/StorageReadinessInterface'

export class S3StorageReadiness implements StorageReadinessInterface {
  constructor(
    private readonly s3Client: S3Client,
    private readonly bucketName: string,
    private readonly timeoutMs = 1_500,
  ) {}

  async check(): Promise<void> {
    // HeadBucket is authenticated and non-mutating. The deployment credential
    // must grant s3:ListBucket, which the existing listFiles/quota path already
    // requires; a missing permission deliberately fails readiness closed.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    timer.unref()
    try {
      await this.s3Client.send(new HeadBucketCommand({ Bucket: this.bucketName }), {
        abortSignal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }
}

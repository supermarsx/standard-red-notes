import * as uuid from 'uuid'
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { KeyParamsData } from '@standardnotes/responses'
import { Logger } from 'winston'

import { Item } from '../../Domain/Item/Item'
import { BackupContentTooLargeError } from '../../Domain/Item/BackupContentTooLargeError'
import { ItemBackupServiceInterface } from '../../Domain/Item/ItemBackupServiceInterface'
import { MapperInterface, Result } from '@standardnotes/domain-core'
import { ItemBackupRepresentation } from '../../Mapping/Backup/ItemBackupRepresentation'
import { ItemHttpRepresentation } from '../../Mapping/Http/ItemHttpRepresentation'

export class S3ItemBackupService implements ItemBackupServiceInterface {
  constructor(
    private s3BackupBucketName: string,
    private backupMapper: MapperInterface<Item, ItemBackupRepresentation>,
    private httpMapper: MapperInterface<Item, ItemHttpRepresentation>,
    private logger: Logger,
    private s3Client?: S3Client,
  ) {}

  async dump(item: Item): Promise<Result<string>> {
    try {
      if (!this.s3BackupBucketName || this.s3Client === undefined) {
        this.logger.warn('S3 backup not configured')

        return Result.fail('S3 backup not configured')
      }

      const s3Key = uuid.v4()
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.s3BackupBucketName,
          Key: s3Key,
          Body: JSON.stringify({
            item: this.backupMapper.toProjection(item),
          }),
          IfNoneMatch: '*',
        }),
      )

      return Result.ok(s3Key)
    } catch (error) {
      return Result.fail(`Could not dump item: ${(error as Error).message}`)
    }
  }

  async backup(items: Item[], authParams: KeyParamsData, contentSizeLimit?: number): Promise<string[]> {
    if (items.length === 0) {
      return []
    }

    if (!this.s3BackupBucketName || this.s3Client === undefined) {
      this.logger.warn('S3 backup not configured')

      throw new Error('S3 backup not configured')
    }

    if (contentSizeLimit !== undefined && (!Number.isSafeInteger(contentSizeLimit) || contentSizeLimit <= 0)) {
      throw new Error('Backup content size limit must be a positive integer')
    }

    const fileNames: string[] = []
    let itemProjections: ItemHttpRepresentation[] = []
    try {
      for (const item of items) {
        const itemProjection = this.httpMapper.toProjection(item)
        if (
          contentSizeLimit !== undefined &&
          this.backupContentsByteLength([itemProjection], authParams) > contentSizeLimit
        ) {
          throw new BackupContentTooLargeError()
        }
        const candidateProjections = [...itemProjections, itemProjection]

        if (
          contentSizeLimit !== undefined &&
          itemProjections.length > 0 &&
          this.backupContentsByteLength(candidateProjections, authParams) > contentSizeLimit
        ) {
          const backupFileName = await this.createBackupFile(itemProjections, authParams)
          fileNames.push(backupFileName)

          itemProjections = [itemProjection]
        } else {
          itemProjections = candidateProjections
        }
      }

      if (itemProjections.length > 0) {
        const backupFileName = await this.createBackupFile(itemProjections, authParams)
        fileNames.push(backupFileName)
      }

      return fileNames
    } catch (error) {
      await this.deleteIncompleteBackups(fileNames)
      throw error
    }
  }

  async delete(fileName: string): Promise<void> {
    if (!this.s3BackupBucketName || this.s3Client === undefined) {
      throw new Error('S3 backup not configured')
    }

    await this.s3Client.send(
      new DeleteObjectCommand({
        Bucket: this.s3BackupBucketName,
        Key: fileName,
      }),
    )
  }

  private async createBackupFile(
    itemRepresentations: ItemHttpRepresentation[],
    authParams: KeyParamsData,
  ): Promise<string> {
    if (itemRepresentations.length === 0) {
      throw new Error('Refusing to create an empty backup file')
    }

    const fileName = uuid.v4()

    await (this.s3Client as S3Client).send(
      new PutObjectCommand({
        Bucket: this.s3BackupBucketName,
        Key: fileName,
        Body: this.backupContents(itemRepresentations, authParams),
        IfNoneMatch: '*',
      }),
    )

    return fileName
  }

  private backupContents(itemRepresentations: ItemHttpRepresentation[], authParams: KeyParamsData): string {
    return JSON.stringify({
      items: itemRepresentations,
      auth_params: authParams,
    })
  }

  private backupContentsByteLength(itemRepresentations: ItemHttpRepresentation[], authParams: KeyParamsData): number {
    return Buffer.byteLength(this.backupContents(itemRepresentations, authParams), 'utf8')
  }

  private async deleteIncompleteBackups(fileNames: string[]): Promise<void> {
    for (const fileName of fileNames) {
      try {
        await this.delete(fileName)
      } catch {
        try {
          this.logger.error('Incomplete S3 item backup could not be deleted')
        } catch {
          // Preserve the primary backup failure even if diagnostics are broken.
        }
      }
    }
  }
}

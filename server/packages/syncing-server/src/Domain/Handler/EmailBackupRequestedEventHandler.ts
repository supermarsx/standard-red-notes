import {
  DomainEventHandlerInterface,
  DomainEventPublisherInterface,
  EmailBackupRequestedEvent,
} from '@standardnotes/domain-events'
import { Email, EmailLevel, Uuid } from '@standardnotes/domain-core'
import { Logger } from 'winston'
import * as uuid from 'uuid'
import { DomainEventFactoryInterface } from '../Event/DomainEventFactoryInterface'
import { ItemBackupServiceInterface } from '../Item/ItemBackupServiceInterface'
import { BackupContentTooLargeError } from '../Item/BackupContentTooLargeError'
import { ItemRepositoryInterface } from '../Item/ItemRepositoryInterface'
import { ItemTransferCalculatorInterface } from '../Item/ItemTransferCalculatorInterface'
import { ItemQuery } from '../Item/ItemQuery'
import { getBody, getSubject } from '../Email/EmailBackupAttachmentCreated'
import { getEmailBackupFailedBody, getEmailBackupFailedSubject } from '../Email/EmailBackupFailed'

export class EmailBackupRequestedEventHandler implements DomainEventHandlerInterface {
  constructor(
    private primaryItemRepository: ItemRepositoryInterface,
    private itemBackupService: ItemBackupServiceInterface,
    private domainEventPublisher: DomainEventPublisherInterface,
    private domainEventFactory: DomainEventFactoryInterface,
    private emailAttachmentMaxByteSize: number,
    private itemTransferCalculator: ItemTransferCalculatorInterface,
    private backupFileLocation: string,
    private logger: Logger,
  ) {}

  async handle(event: EmailBackupRequestedEvent): Promise<void> {
    await this.requestEmailWithBackupFile(event, this.primaryItemRepository)
  }

  // The auth service is the single EMAIL_REQUESTED delivery owner. It validates
  // this storage reference against its configured S3 bucket or shared local
  // backup directory, sends the encrypted bytes over SMTP, and removes them only
  // after SMTP confirms acceptance.

  private async requestEmailWithBackupFile(
    event: EmailBackupRequestedEvent,
    itemRepository: ItemRepositoryInterface,
  ): Promise<void> {
    const userUuidValue = event.payload?.userUuid
    const userUuidOrError = Uuid.create(userUuidValue)
    if (userUuidOrError.isFailed()) {
      this.logger.error('User uuid is invalid', {
        userId: userUuidValue,
        codeTag: 'EmailBackupRequestedEventHandler',
      })

      return
    }
    const userUuid = userUuidOrError.getValue()
    const keyParams = event.payload?.keyParams
    const userEmailOrError = Email.create(keyParams?.identifier as string)
    if (userEmailOrError.isFailed()) {
      this.logger.error('User email identifier is invalid', {
        userId: userUuidValue,
        codeTag: 'EmailBackupRequestedEventHandler',
      })

      return
    }
    const userEmail = userEmailOrError.getValue().value

    const itemQuery: ItemQuery = {
      userUuid: userUuidValue,
      sortBy: 'updated_at_timestamp',
      sortOrder: 'ASC',
      deleted: false,
    }
    const itemContentSizeDescriptors = await itemRepository.findContentSizeForComputingTransferLimit(itemQuery)
    const itemUuidBundles = await this.itemTransferCalculator.computeItemUuidBundlesToFetch(
      itemContentSizeDescriptors,
      this.emailAttachmentMaxByteSize,
      userUuid,
    )

    const backupFileNames: string[] = []
    try {
      for (const itemUuidBundle of itemUuidBundles) {
        const items = await itemRepository.findAll({
          uuids: itemUuidBundle,
          sortBy: 'updated_at_timestamp',
          sortOrder: 'ASC',
        })

        const bundleBackupFileNames = await this.itemBackupService.backup(
          items,
          keyParams,
          this.emailAttachmentMaxByteSize,
        )

        backupFileNames.push(...bundleBackupFileNames)
      }
    } catch (error) {
      await this.cleanupBackupFiles(backupFileNames)
      if (error instanceof BackupContentTooLargeError) {
        await this.publishOversizedBackupFailure(userUuidValue, userEmail)

        return
      }

      throw error
    }

    const dateOnly = new Date().toISOString().substring(0, 10)
    if (backupFileNames.length > 0) {
      const backupBatchId = uuid.v4()
      try {
        await this.domainEventPublisher.publish(
          this.domainEventFactory.createEmailRequestedEvent({
            backupBatchId,
            body: getBody(userEmail),
            level: EmailLevel.LEVELS.System,
            messageIdentifier: 'DATA_BACKUP',
            subject: getSubject(1, backupFileNames.length, dateOnly),
            userEmail,
            sender: 'backups@standardnotes.org',
            attachments: backupFileNames.map((backupFileName, index) => ({
              fileName: backupFileName,
              filePath: this.backupFileLocation,
              attachmentFileName:
                backupFileNames.length === 1
                  ? `SN-Data-${dateOnly}.txt`
                  : `SN-Data-${dateOnly}-Part-${index + 1}-Of-${backupFileNames.length}.txt`,
              attachmentContentType: 'application/json',
              emailSubject: getSubject(index + 1, backupFileNames.length, dateOnly),
              batchIndex: index + 1,
              batchCount: backupFileNames.length,
            })),
            userUuid: userUuidValue,
          }),
        )
      } catch (error) {
        await this.cleanupBackupFiles(backupFileNames)
        throw error
      }
    }

    this.logger.info('Email with backup requested for user', {
      userId: userUuidValue,
    })
  }

  private async publishOversizedBackupFailure(userUuid: string, userEmail: string): Promise<void> {
    await this.domainEventPublisher.publish(
      this.domainEventFactory.createEmailRequestedEvent({
        body: getEmailBackupFailedBody(),
        level: EmailLevel.LEVELS.System,
        messageIdentifier: 'DATA_BACKUP_FAILED',
        subject: getEmailBackupFailedSubject(),
        userEmail,
        sender: 'backups@standardnotes.org',
        userUuid,
      }),
    )

    this.logger.warn('Email backup could not be created because an item exceeds the attachment limit', {
      codeTag: 'EmailBackupRequestedEventHandler',
      userId: userUuid,
    })
  }

  private async cleanupBackupFiles(fileNames: string[]): Promise<void> {
    for (const fileName of fileNames) {
      try {
        await this.itemBackupService.delete(fileName)
      } catch {
        try {
          this.logger.error('Incomplete email backup artifact could not be deleted', {
            codeTag: 'EmailBackupRequestedEventHandler',
          })
        } catch {
          // Preserve the primary backup or publication failure.
        }
      }
    }
  }
}

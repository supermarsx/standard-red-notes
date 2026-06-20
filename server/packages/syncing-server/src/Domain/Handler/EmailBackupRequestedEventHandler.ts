import {
  DomainEventHandlerInterface,
  DomainEventPublisherInterface,
  EmailBackupRequestedEvent,
} from '@standardnotes/domain-events'
import { EmailLevel, Uuid } from '@standardnotes/domain-core'
import { Logger } from 'winston'
import { DomainEventFactoryInterface } from '../Event/DomainEventFactoryInterface'
import { ItemBackupServiceInterface } from '../Item/ItemBackupServiceInterface'
import { ItemRepositoryInterface } from '../Item/ItemRepositoryInterface'
import { ItemTransferCalculatorInterface } from '../Item/ItemTransferCalculatorInterface'
import { ItemQuery } from '../Item/ItemQuery'
import { getBody, getSubject } from '../Email/EmailBackupAttachmentCreated'

export class EmailBackupRequestedEventHandler implements DomainEventHandlerInterface {
  constructor(
    private primaryItemRepository: ItemRepositoryInterface,
    private itemBackupService: ItemBackupServiceInterface,
    private domainEventPublisher: DomainEventPublisherInterface,
    private domainEventFactory: DomainEventFactoryInterface,
    private emailAttachmentMaxByteSize: number,
    private itemTransferCalculator: ItemTransferCalculatorInterface,
    private s3BackupBucketName: string,
    private logger: Logger,
  ) {}

  async handle(event: EmailBackupRequestedEvent): Promise<void> {
    await this.requestEmailWithBackupFile(event, this.primaryItemRepository)
  }

  // ---------------------------------------------------------------------------
  // Standard Red Notes — DELIVERY GAP (scaffolded, not fully wired):
  //
  // This handler produces the user's ALREADY end-to-end-encrypted items as a
  // backup file in the S3 backup bucket, then publishes an EMAIL_REQUESTED domain
  // event whose `attachments[].filePath` points at that S3 object.
  //
  // In upstream Standard Notes, EMAIL_REQUESTED was consumed by a separate,
  // closed-source `email` micro-service (via SNS/SQS) that fetched the attachment
  // from S3 and sent it over SMTP. THIS FORK HAS NO EMAIL_REQUESTED CONSUMER, so
  // the backup file is generated but never actually emailed.
  //
  // To fully wire delivery, a new EMAIL_REQUESTED handler is needed that, when the
  // operator has enabled email backups (EMAIL_BACKUPS_ENABLED) and SMTP is
  // configured, (1) fetches the attachment object from the S3 backup bucket and
  // (2) calls an SMTP sender with the attachment (the existing
  // auth/.../SmtpEmailSender currently only sends text bodies, so it would need an
  // attachment-capable send path, or a dedicated sender here). SMTP creds are the
  // remaining operator-supplied config. See TriggerEmailBackupForAllUsers for the
  // operator gate and per-user due-calculation that drive this event.
  // ---------------------------------------------------------------------------

  private async requestEmailWithBackupFile(
    event: EmailBackupRequestedEvent,
    itemRepository: ItemRepositoryInterface,
  ): Promise<void> {
    const userUuidOrError = Uuid.create(event.payload.userUuid)
    if (userUuidOrError.isFailed()) {
      this.logger.error('User uuid is invalid', {
        userId: event.payload.userUuid,
        codeTag: 'EmailBackupRequestedEventHandler',
      })

      return
    }
    const userUuid = userUuidOrError.getValue()

    const itemQuery: ItemQuery = {
      userUuid: event.payload.userUuid,
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
    for (const itemUuidBundle of itemUuidBundles) {
      const items = await itemRepository.findAll({
        uuids: itemUuidBundle,
        sortBy: 'updated_at_timestamp',
        sortOrder: 'ASC',
      })

      const bundleBackupFileNames = await this.itemBackupService.backup(
        items,
        event.payload.keyParams,
        this.emailAttachmentMaxByteSize,
      )

      backupFileNames.push(...bundleBackupFileNames)
    }

    const dateOnly = new Date().toISOString().substring(0, 10)
    let bundleIndex = 1

    for (const backupFileName of backupFileNames) {
      await this.domainEventPublisher.publish(
        this.domainEventFactory.createEmailRequestedEvent({
          body: getBody(event.payload.keyParams.identifier as string),
          level: EmailLevel.LEVELS.System,
          messageIdentifier: 'DATA_BACKUP',
          subject: getSubject(bundleIndex++, backupFileNames.length, dateOnly),
          userEmail: event.payload.keyParams.identifier as string,
          sender: 'backups@standardnotes.org',
          attachments: [
            {
              fileName: backupFileName,
              filePath: this.s3BackupBucketName,
              attachmentFileName: `SN-Data-${dateOnly}.txt`,
              attachmentContentType: 'application/json',
            },
          ],
          userUuid: event.payload.userUuid,
        }),
      )
    }

    this.logger.info('Email with backup requested for user', {
      userId: event.payload.userUuid,
    })
  }
}

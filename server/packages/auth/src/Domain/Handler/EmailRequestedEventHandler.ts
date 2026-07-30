import { Email, SettingName, Uuid } from '@standardnotes/domain-core'
import { DomainEventHandlerInterface, EmailRequestedEvent } from '@standardnotes/domain-events'
import { TimerInterface } from '@standardnotes/time'
import { Logger } from 'winston'

import {
  BackupAttachmentAlreadyDeliveredError,
  BackupAttachmentNotFoundError,
  BackupAttachmentReference,
  BackupAttachmentStorageInterface,
  BackupAttachmentTooLargeError,
  InvalidBackupAttachmentReferenceError,
} from '../Email/BackupAttachmentStorageInterface'
import { EmailAttachment, EmailSenderInterface } from '../Email/EmailSenderInterface'
import { GetSetting } from '../UseCase/GetSetting/GetSetting'
import { SetSettingValue } from '../UseCase/SetSettingValue/SetSettingValue'

type AttachmentReadResult =
  { status: 'ready'; content: Buffer } | { status: 'already-delivered' } | { status: 'rejected' }

interface CompletedEmailBackupBatch {
  batchId: string
  deliveredAt: number
}

interface EmailBackupDeliveryState {
  completed: CompletedEmailBackupBatch[]
}

export class EmailRequestedEventHandler implements DomainEventHandlerInterface {
  private static readonly DATA_BACKUP_MESSAGE_IDENTIFIER = 'DATA_BACKUP'
  private static readonly DATA_BACKUP_FAILED_MESSAGE_IDENTIFIER = 'DATA_BACKUP_FAILED'
  private static readonly MAX_COMPLETED_BATCH_HISTORY = 32

  constructor(
    private emailSender: EmailSenderInterface,
    private backupAttachmentStorage: BackupAttachmentStorageInterface,
    private getSetting: GetSetting,
    private setSettingValue: SetSettingValue,
    private timer: TimerInterface,
    private emailBackupsEnabled: boolean,
    private logger: Logger,
  ) {}

  async handle(event: EmailRequestedEvent): Promise<void> {
    const messageIdentifier = this.safeMessageIdentifier(event.payload?.messageIdentifier)
    const recipientOrError = Email.create(event.payload?.userEmail)
    if (recipientOrError.isFailed()) {
      this.logRejected('recipient is invalid', messageIdentifier)

      return
    }

    if (!this.hasValidMessage(event)) {
      this.logRejected('message fields are invalid', messageIdentifier)

      return
    }

    const isDataBackup = messageIdentifier === EmailRequestedEventHandler.DATA_BACKUP_MESSAGE_IDENTIFIER
    const isDataBackupFailure = messageIdentifier === EmailRequestedEventHandler.DATA_BACKUP_FAILED_MESSAGE_IDENTIFIER
    const isBackupOutcome = isDataBackup || isDataBackupFailure
    if (event.payload.attachments !== undefined && !Array.isArray(event.payload.attachments)) {
      this.logRejected('attachment metadata is invalid', messageIdentifier)

      return
    }
    const attachmentReferences = event.payload.attachments ?? []
    if (!this.hasValidAttachments(isDataBackup, attachmentReferences)) {
      this.logRejected('attachment metadata is invalid', messageIdentifier)

      return
    }

    if (isBackupOutcome && !this.emailBackupsEnabled) {
      await this.discardDisabledBackup(attachmentReferences, messageIdentifier)

      return
    }

    let backupUserUuid: string | undefined
    if (isBackupOutcome) {
      backupUserUuid = this.validBackupUserUuid(event.payload.userUuid)
      if (!backupUserUuid) {
        this.logRejected('user uuid is invalid', messageIdentifier)

        return
      }
    }

    if (isDataBackup) {
      await this.handleBackupBatch(
        event,
        recipientOrError.getValue().value,
        backupUserUuid as string,
        attachmentReferences,
        messageIdentifier,
      )

      return
    }

    const delivered = await this.deliver(
      recipientOrError.getValue().value,
      event.payload.subject,
      event.payload.body,
      [],
      messageIdentifier,
    )
    if (!delivered) {
      throw new Error('Email delivery was not confirmed')
    }

    if (isDataBackupFailure) {
      await this.recordLastSent(
        backupUserUuid as string,
        this.timer.convertMicrosecondsToMilliseconds(this.timer.getTimestampInMicroseconds()),
        messageIdentifier,
      )
    }

    this.logDelivered(messageIdentifier)
  }

  private async handleBackupBatch(
    event: EmailRequestedEvent,
    recipient: string,
    userUuid: string,
    attachmentReferences: BackupAttachmentReference[],
    messageIdentifier: string,
  ): Promise<void> {
    const batchId = this.resolveBatchId(event, attachmentReferences)
    if (!batchId) {
      this.logRejected('batch metadata is invalid', messageIdentifier)

      return
    }

    const state = await this.readDeliveryState(userUuid)
    const completedBatch = state.completed.find((entry) => entry.batchId === batchId)
    if (completedBatch) {
      await this.recordLastSent(userUuid, completedBatch.deliveredAt, messageIdentifier)
      await this.cleanupDeliveredAttachments(attachmentReferences, messageIdentifier)
      this.logDelivered(messageIdentifier)

      return
    }

    const orderedReferences = [...attachmentReferences].sort(
      (left, right) => (left.batchIndex ?? 1) - (right.batchIndex ?? 1),
    )
    for (const reference of orderedReferences) {
      const readResult = await this.readAttachment(reference, messageIdentifier)
      if (readResult.status === 'rejected') {
        await this.cleanupDeliveredAttachments(attachmentReferences, messageIdentifier, 'Rejected')
        return
      }
      if (readResult.status === 'already-delivered') {
        continue
      }

      const attachment: EmailAttachment = {
        filename: reference.attachmentFileName,
        contentType: reference.attachmentContentType,
        content: readResult.content,
      }
      const delivered = await this.deliver(
        recipient,
        reference.emailSubject ?? event.payload.subject,
        event.payload.body,
        [attachment],
        messageIdentifier,
      )
      if (!delivered) {
        throw new Error('Email delivery was not confirmed')
      }

      try {
        await this.backupAttachmentStorage.markDelivered(reference)
      } catch {
        this.logger.error('Delivered email backup attachment could not be receipted', {
          codeTag: 'EmailRequestedEventHandler',
          messageIdentifier,
        })
        throw new Error('Email backup delivery receipt could not be persisted')
      }
    }

    const deliveredAt = this.timer.convertMicrosecondsToMilliseconds(this.timer.getTimestampInMicroseconds())
    await this.recordBatchCompleted(userUuid, batchId, deliveredAt, state, messageIdentifier)
    await this.recordLastSent(userUuid, deliveredAt, messageIdentifier)
    await this.cleanupDeliveredAttachments(attachmentReferences, messageIdentifier)
    this.logDelivered(messageIdentifier)
  }

  private hasValidMessage(event: EmailRequestedEvent): boolean {
    return (
      typeof event.payload?.subject === 'string' &&
      this.isSafeSubject(event.payload.subject) &&
      typeof event.payload.body === 'string' &&
      this.isSafeMessageIdentifier(event.payload.messageIdentifier)
    )
  }

  private hasValidAttachments(isDataBackup: boolean, attachments: BackupAttachmentReference[]): boolean {
    if (!isDataBackup) {
      return attachments.length === 0
    }
    if (attachments.length === 0) {
      return false
    }

    const batchIndexes = new Set<number>()
    for (const attachment of attachments) {
      if (!attachment || typeof attachment !== 'object') {
        return false
      }
      const validLegacySingleAttachment =
        attachments.length === 1 && attachment.batchIndex === undefined && attachment.batchCount === undefined
      const validBatchPosition =
        validLegacySingleAttachment ||
        (Number.isSafeInteger(attachment.batchIndex) &&
          attachment.batchIndex !== undefined &&
          attachment.batchIndex >= 1 &&
          attachment.batchIndex <= attachments.length &&
          attachment.batchCount === attachments.length &&
          !batchIndexes.has(attachment.batchIndex))

      if (
        attachment.attachmentContentType !== 'application/json' ||
        !this.isSafeAttachmentFileName(attachment.attachmentFileName) ||
        (attachment.emailSubject !== undefined && !this.isSafeSubject(attachment.emailSubject)) ||
        !validBatchPosition
      ) {
        return false
      }

      if (attachment.batchIndex !== undefined) {
        batchIndexes.add(attachment.batchIndex)
      }
    }

    return true
  }

  private async readAttachment(
    reference: BackupAttachmentReference,
    messageIdentifier: string,
  ): Promise<AttachmentReadResult> {
    try {
      return {
        status: 'ready',
        content: await this.backupAttachmentStorage.read(reference),
      }
    } catch (error) {
      if (error instanceof BackupAttachmentAlreadyDeliveredError) {
        this.logger.info('Email backup attachment already has a delivery receipt', {
          codeTag: 'EmailRequestedEventHandler',
          messageIdentifier,
        })

        return { status: 'already-delivered' }
      }

      if (error instanceof InvalidBackupAttachmentReferenceError) {
        this.logger.error('Email backup attachment reference was rejected', {
          codeTag: 'EmailRequestedEventHandler',
          messageIdentifier,
        })

        return { status: 'rejected' }
      }

      if (error instanceof BackupAttachmentTooLargeError) {
        this.logger.error('Email backup attachment exceeds the configured byte limit', {
          codeTag: 'EmailRequestedEventHandler',
          messageIdentifier,
        })

        return { status: 'rejected' }
      }

      this.logger.error(
        error instanceof BackupAttachmentNotFoundError
          ? 'Email backup attachment is not available'
          : 'Email backup attachment could not be read',
        {
          codeTag: 'EmailRequestedEventHandler',
          messageIdentifier,
        },
      )
      throw new Error('Email backup attachment could not be read')
    }
  }

  private async discardDisabledBackup(
    attachmentReferences: BackupAttachmentReference[],
    messageIdentifier: string,
  ): Promise<void> {
    await this.cleanupDeliveredAttachments(attachmentReferences, messageIdentifier, 'Disabled')
    this.logger.warn('Email backup request discarded because delivery is disabled', {
      codeTag: 'EmailRequestedEventHandler',
      messageIdentifier,
    })
  }

  private async cleanupDeliveredAttachments(
    attachmentReferences: BackupAttachmentReference[],
    messageIdentifier: string,
    reason = 'Delivered',
  ): Promise<void> {
    for (const reference of attachmentReferences) {
      try {
        await this.backupAttachmentStorage.delete(reference)
      } catch {
        this.logger.error(`${reason} email backup attachment could not be deleted`, {
          codeTag: 'EmailRequestedEventHandler',
          messageIdentifier,
        })
      }
    }
  }

  private async deliver(
    recipient: string,
    subject: string,
    body: string,
    attachments: EmailAttachment[],
    messageIdentifier: string,
  ): Promise<boolean> {
    try {
      return await this.emailSender.sendEmail(
        recipient,
        subject,
        body,
        attachments.length > 0 ? { attachments, html: true } : { html: true },
      )
    } catch {
      this.logger.error('Email delivery provider failed', {
        codeTag: 'EmailRequestedEventHandler',
        messageIdentifier,
      })

      return false
    }
  }

  private async readDeliveryState(userUuid: string): Promise<EmailBackupDeliveryState> {
    const result = await this.getSetting.execute({
      userUuid,
      settingName: SettingName.NAMES.EmailBackupDeliveryState,
      allowSensitiveRetrieval: false,
      decrypted: true,
    })
    if (result.isFailed()) {
      return { completed: [] }
    }

    try {
      const parsed = JSON.parse(result.getValue().decryptedValue ?? '') as Partial<EmailBackupDeliveryState>
      if (!Array.isArray(parsed.completed)) {
        return { completed: [] }
      }

      return {
        completed: parsed.completed
          .filter(
            (entry): entry is CompletedEmailBackupBatch =>
              typeof entry?.batchId === 'string' &&
              entry.batchId.length > 0 &&
              entry.batchId.length <= 300 &&
              Number.isSafeInteger(entry.deliveredAt) &&
              entry.deliveredAt >= 0,
          )
          .slice(-EmailRequestedEventHandler.MAX_COMPLETED_BATCH_HISTORY),
      }
    } catch {
      return { completed: [] }
    }
  }

  private async recordBatchCompleted(
    userUuid: string,
    batchId: string,
    deliveredAt: number,
    state: EmailBackupDeliveryState,
    messageIdentifier: string,
  ): Promise<void> {
    const completed = [...state.completed.filter((entry) => entry.batchId !== batchId), { batchId, deliveredAt }].slice(
      -EmailRequestedEventHandler.MAX_COMPLETED_BATCH_HISTORY,
    )
    await this.setServerSetting(
      userUuid,
      SettingName.NAMES.EmailBackupDeliveryState,
      JSON.stringify({ completed }),
      'Email backup delivery state could not be recorded',
      messageIdentifier,
    )
  }

  private async recordLastSent(userUuid: string, timestamp: number, messageIdentifier: string): Promise<void> {
    await this.setServerSetting(
      userUuid,
      SettingName.NAMES.EmailBackupLastSent,
      String(timestamp),
      'Email backup last-sent timestamp could not be recorded',
      messageIdentifier,
    )
  }

  private async setServerSetting(
    userUuid: string,
    settingName: string,
    value: string,
    logMessage: string,
    messageIdentifier: string,
  ): Promise<void> {
    try {
      const result = await this.setSettingValue.execute({
        settingName,
        value,
        userUuid,
        checkUserPermissions: false,
      })
      if (result.isFailed()) {
        throw new Error('Setting write was rejected')
      }
    } catch {
      this.logger.error(logMessage, {
        codeTag: 'EmailRequestedEventHandler',
        messageIdentifier,
      })
      throw new Error('Email backup bookkeeping could not be persisted')
    }
  }

  private resolveBatchId(
    event: EmailRequestedEvent,
    attachmentReferences: BackupAttachmentReference[],
  ): string | undefined {
    const requestedBatchId = event.payload.backupBatchId
    if (typeof requestedBatchId === 'string' && !Uuid.create(requestedBatchId).isFailed()) {
      return requestedBatchId
    }

    if (requestedBatchId === undefined && attachmentReferences.length === 1) {
      return `legacy-${attachmentReferences[0].fileName}`
    }

    return undefined
  }

  private isSafeAttachmentFileName(fileName: unknown): fileName is string {
    return (
      typeof fileName === 'string' &&
      fileName.length > 0 &&
      fileName.length <= 255 &&
      !fileName.includes('..') &&
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(fileName)
    )
  }

  private isSafeSubject(subject: string): boolean {
    return subject.trim().length > 0 && subject.length <= 998 && !subject.includes('\r') && !subject.includes('\n')
  }

  private safeMessageIdentifier(identifier: unknown): string {
    return this.isSafeMessageIdentifier(identifier) ? identifier : 'UNKNOWN'
  }

  private isSafeMessageIdentifier(identifier: unknown): identifier is string {
    return typeof identifier === 'string' && /^[A-Z0-9_]{1,64}$/.test(identifier)
  }

  private validBackupUserUuid(userUuid: unknown): string | undefined {
    if (typeof userUuid !== 'string') {
      return undefined
    }

    const userUuidOrError = Uuid.create(userUuid)

    return userUuidOrError.isFailed() ? undefined : userUuidOrError.getValue().value
  }

  private logRejected(reason: string, messageIdentifier: string): void {
    this.logger.error(`Email request rejected because its ${reason}`, {
      codeTag: 'EmailRequestedEventHandler',
      messageIdentifier,
    })
  }

  private logDelivered(messageIdentifier: string): void {
    this.logger.info('Email request delivered', {
      codeTag: 'EmailRequestedEventHandler',
      messageIdentifier,
    })
  }
}

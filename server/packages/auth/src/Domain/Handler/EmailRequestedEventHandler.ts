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
import {
  EmailBackupDeliveryState,
  PendingEmailBackupBatch,
  emptyEmailBackupDeliveryState,
  parseEmailBackupDeliveryState,
  pendingBatchMatches,
  recordCompletedEmailBackupBatch,
  recordPendingEmailBackupBatch,
  serializeEmailBackupDeliveryState,
} from '../Email/EmailBackupDeliveryState'
import { applyEmailBackupStatePatch } from '../Email/EmailBackupStatePatch'
import { EmailBackupStateRepositoryInterface } from '../Email/EmailBackupStateRepositoryInterface'
import { EmailAttachment, EmailDeliveryStatus, EmailSenderInterface } from '../Email/EmailSenderInterface'
import { createEmailDeliveryId } from '../Email/EmailDeliveryId'
import { GetSetting } from '../UseCase/GetSetting/GetSetting'
import { SetSettingValue } from '../UseCase/SetSettingValue/SetSettingValue'

type AttachmentReadResult =
  { status: 'ready'; content: Buffer } | { status: 'already-delivered' } | { status: 'rejected' }

interface EmailDeliveryAcceptance {
  accepted: boolean
  terminal: boolean
}

export class EmailRequestedEventHandler implements DomainEventHandlerInterface {
  private static readonly DATA_BACKUP_MESSAGE_IDENTIFIER = 'DATA_BACKUP'
  private static readonly DATA_BACKUP_FAILED_MESSAGE_IDENTIFIER = 'DATA_BACKUP_FAILED'
  constructor(
    private emailSender: EmailSenderInterface,
    private backupAttachmentStorage: BackupAttachmentStorageInterface,
    private getSetting: GetSetting,
    private setSettingValue: SetSettingValue,
    private timer: TimerInterface,
    private emailBackupsEnabled: boolean,
    private logger: Logger,
    private emailBackupStateRepository?: EmailBackupStateRepositoryInterface,
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

    if (isDataBackupFailure) {
      await this.handleBackupFailureNotice(
        event,
        recipientOrError.getValue().value,
        backupUserUuid as string,
        messageIdentifier,
      )

      return
    }

    const delivery = await this.deliver(
      recipientOrError.getValue().value,
      event.payload.subject,
      event.payload.body,
      [],
      messageIdentifier,
      this.deliveryIdForEvent(event, messageIdentifier),
    )
    if (!delivery.accepted) {
      throw new Error('Email delivery was not confirmed')
    }

    this.logAccepted(messageIdentifier, delivery.terminal)
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
      this.logAccepted(messageIdentifier, true)

      return
    }

    const orderedReferences = [...attachmentReferences].sort(
      (left, right) => (left.batchIndex ?? 1) - (right.batchIndex ?? 1),
    )

    if (this.emailSender.acceptanceMode === 'durable-queue') {
      await this.handleDurableBackupBatch(
        event,
        recipient,
        userUuid,
        batchId,
        orderedReferences,
        state,
        messageIdentifier,
      )

      return
    }

    if (state.pending.length > 0) {
      this.logBackupDeliveryBlocked(messageIdentifier, batchId, 'durable-status-unavailable')
      throw new Error('Email backup durable delivery requires operator attention')
    }

    await this.handleDirectBackupBatch(event, recipient, userUuid, batchId, orderedReferences, state, messageIdentifier)
  }

  private async handleDirectBackupBatch(
    event: EmailRequestedEvent,
    recipient: string,
    userUuid: string,
    batchId: string,
    orderedReferences: BackupAttachmentReference[],
    state: EmailBackupDeliveryState,
    messageIdentifier: string,
  ): Promise<void> {
    for (const reference of orderedReferences) {
      const readResult = await this.readAttachment(reference, messageIdentifier)
      if (readResult.status === 'rejected') {
        await this.cleanupDeliveredAttachments(orderedReferences, messageIdentifier, 'Rejected')
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
      const delivery = await this.deliver(
        recipient,
        reference.emailSubject ?? event.payload.subject,
        event.payload.body,
        [attachment],
        messageIdentifier,
        createEmailDeliveryId(
          'backup',
          batchId,
          reference.batchIndex ?? 1,
          reference.fileName,
          reference.attachmentFileName,
        ),
      )
      if (!delivery.accepted) {
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
    await this.cleanupDeliveredAttachments(orderedReferences, messageIdentifier)
    this.logAccepted(messageIdentifier, true)
  }

  private async handleDurableBackupBatch(
    event: EmailRequestedEvent,
    recipient: string,
    userUuid: string,
    batchId: string,
    orderedReferences: BackupAttachmentReference[],
    state: EmailBackupDeliveryState,
    messageIdentifier: string,
  ): Promise<void> {
    const queuedAt = this.nowInMilliseconds()
    const expectedBatch: PendingEmailBackupBatch = {
      batchId,
      outcome: 'backup',
      queuedAt,
      deliveries: orderedReferences.map((reference) => ({
        deliveryId: this.deliveryIdForBackupPart(batchId, reference),
        queueAccepted: false,
        reference,
      })),
    }
    const existingPending = state.pending.find((entry) => entry.batchId === batchId)
    if (existingPending && !pendingBatchMatches(existingPending, expectedBatch)) {
      this.logBackupDeliveryBlocked(messageIdentifier, batchId, 'state-mismatch')
      throw new Error('Email backup delivery state does not match the requested batch')
    }

    let workingState = state
    let workingBatch = existingPending ?? expectedBatch
    if (!existingPending) {
      const previousState = workingState
      workingState = recordPendingEmailBackupBatch(state, expectedBatch)
      await this.recordDeliveryState(userUuid, previousState, workingState, messageIdentifier)
    }

    let everyDeliveryProviderAccepted = true
    for (let index = 0; index < workingBatch.deliveries.length; index++) {
      const delivery = workingBatch.deliveries[index]
      const status = await this.getDurableDeliveryStatus(delivery.deliveryId, messageIdentifier)
      if (status === 'provider-accepted') {
        if (!delivery.queueAccepted) {
          const previousState = workingState
          workingBatch = this.markQueueAccepted(workingBatch, index)
          workingState = recordPendingEmailBackupBatch(workingState, workingBatch)
          await this.recordDeliveryState(userUuid, previousState, workingState, messageIdentifier)
        }
        continue
      }

      everyDeliveryProviderAccepted = false
      if (status === 'pending') {
        if (!delivery.queueAccepted) {
          const previousState = workingState
          workingBatch = this.markQueueAccepted(workingBatch, index)
          workingState = recordPendingEmailBackupBatch(workingState, workingBatch)
          await this.recordDeliveryState(userUuid, previousState, workingState, messageIdentifier)
        }
        continue
      }

      if (status !== 'missing' || delivery.queueAccepted) {
        this.logBackupDeliveryBlocked(messageIdentifier, batchId, status)
        throw new Error('Email backup durable delivery requires operator attention')
      }

      const reference = delivery.reference as BackupAttachmentReference
      const readResult = await this.readAttachment(reference, messageIdentifier)
      if (readResult.status === 'rejected') {
        await this.cleanupDeliveredAttachments(orderedReferences, messageIdentifier, 'Rejected')
        return
      }
      if (readResult.status === 'already-delivered') {
        this.logBackupDeliveryBlocked(messageIdentifier, batchId, 'source-already-receipted')
        throw new Error('Email backup durable delivery requires operator attention')
      }

      const accepted = await this.deliver(
        recipient,
        reference.emailSubject ?? event.payload.subject,
        event.payload.body,
        [
          {
            filename: reference.attachmentFileName,
            contentType: reference.attachmentContentType,
            content: readResult.content,
          },
        ],
        messageIdentifier,
        delivery.deliveryId,
      )
      if (!accepted.accepted) {
        throw new Error('Email delivery was not confirmed')
      }

      const previousState = workingState
      workingBatch = this.markQueueAccepted(workingBatch, index)
      workingState = recordPendingEmailBackupBatch(workingState, workingBatch)
      await this.recordDeliveryState(userUuid, previousState, workingState, messageIdentifier)
    }

    if (everyDeliveryProviderAccepted) {
      await this.finalizeDurableBackupBatch(userUuid, workingBatch, workingState, messageIdentifier)
      this.logAccepted(messageIdentifier, true)

      return
    }

    this.logAccepted(messageIdentifier, false)
  }

  private async handleBackupFailureNotice(
    event: EmailRequestedEvent,
    recipient: string,
    userUuid: string,
    messageIdentifier: string,
  ): Promise<void> {
    const deliveryId = this.deliveryIdForEvent(event, messageIdentifier)
    if (this.emailSender.acceptanceMode === 'provider') {
      const state = await this.readDeliveryState(userUuid)
      if (state.pending.length > 0) {
        this.logBackupDeliveryBlocked(messageIdentifier, `failure-${deliveryId}`, 'durable-status-unavailable')
        throw new Error('Email backup durable delivery requires operator attention')
      }

      const delivery = await this.deliver(
        recipient,
        event.payload.subject,
        event.payload.body,
        [],
        messageIdentifier,
        deliveryId,
      )
      if (!delivery.accepted) {
        throw new Error('Email delivery was not confirmed')
      }

      await this.recordLastSent(userUuid, this.nowInMilliseconds(), messageIdentifier)
      this.logAccepted(messageIdentifier, true)

      return
    }

    const batchId = `failure-${deliveryId}`
    const state = await this.readDeliveryState(userUuid)
    const completedBatch = state.completed.find((entry) => entry.batchId === batchId)
    if (completedBatch) {
      await this.recordLastSent(userUuid, completedBatch.deliveredAt, messageIdentifier)
      this.logAccepted(messageIdentifier, true)

      return
    }

    const expectedBatch: PendingEmailBackupBatch = {
      batchId,
      outcome: 'failure-notice',
      queuedAt: this.nowInMilliseconds(),
      deliveries: [{ deliveryId, queueAccepted: false }],
    }
    const existingPending = state.pending.find((entry) => entry.batchId === batchId)
    if (existingPending && !pendingBatchMatches(existingPending, expectedBatch)) {
      this.logBackupDeliveryBlocked(messageIdentifier, batchId, 'state-mismatch')
      throw new Error('Email backup delivery state does not match the requested batch')
    }

    let workingState = state
    let workingBatch = existingPending ?? expectedBatch
    if (!existingPending) {
      const previousState = workingState
      workingState = recordPendingEmailBackupBatch(state, expectedBatch)
      await this.recordDeliveryState(userUuid, previousState, workingState, messageIdentifier)
    }

    const status = await this.getDurableDeliveryStatus(deliveryId, messageIdentifier)
    if (status === 'provider-accepted') {
      await this.finalizeDurableBackupBatch(userUuid, workingBatch, workingState, messageIdentifier)
      this.logAccepted(messageIdentifier, true)

      return
    }
    if (status !== 'pending') {
      if (status !== 'missing' || workingBatch.deliveries[0].queueAccepted) {
        this.logBackupDeliveryBlocked(messageIdentifier, batchId, status)
        throw new Error('Email backup durable delivery requires operator attention')
      }

      const delivery = await this.deliver(
        recipient,
        event.payload.subject,
        event.payload.body,
        [],
        messageIdentifier,
        deliveryId,
      )
      if (!delivery.accepted) {
        throw new Error('Email delivery was not confirmed')
      }
    }

    if (!workingBatch.deliveries[0].queueAccepted) {
      const previousState = workingState
      workingBatch = this.markQueueAccepted(workingBatch, 0)
      workingState = recordPendingEmailBackupBatch(workingState, workingBatch)
      await this.recordDeliveryState(userUuid, previousState, workingState, messageIdentifier)
    }
    this.logAccepted(messageIdentifier, false)
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
    deliveryId: string,
  ): Promise<EmailDeliveryAcceptance> {
    try {
      const accepted = await this.emailSender.sendEmail(
        recipient,
        subject,
        body,
        attachments.length > 0
          ? { attachments, html: true, deliverySource: 'backup', deliveryId }
          : {
              html: true,
              deliveryId,
              ...(messageIdentifier.startsWith('DATA_BACKUP') ? { deliverySource: 'backup' as const } : {}),
            },
      )
      return {
        accepted,
        terminal: accepted && this.emailSender.acceptanceMode === 'provider',
      }
    } catch {
      this.logger.error('Email delivery provider failed', {
        codeTag: 'EmailRequestedEventHandler',
        messageIdentifier,
      })

      return { accepted: false, terminal: false }
    }
  }

  private deliveryIdForEvent(event: EmailRequestedEvent, messageIdentifier: string): string {
    const createdAt = event.createdAt instanceof Date ? event.createdAt.getTime() : String(event.createdAt)

    return createEmailDeliveryId(
      messageIdentifier.startsWith('DATA_BACKUP') ? 'backup-event' : 'domain-email',
      createdAt,
      event.meta.correlation.userIdentifierType,
      event.meta.correlation.userIdentifier,
      messageIdentifier,
      event.payload.subject,
      event.payload.body,
    )
  }

  private deliveryIdForBackupPart(batchId: string, reference: BackupAttachmentReference): string {
    return createEmailDeliveryId(
      'backup',
      batchId,
      reference.batchIndex ?? 1,
      reference.fileName,
      reference.attachmentFileName,
    )
  }

  private async getDurableDeliveryStatus(deliveryId: string, messageIdentifier: string): Promise<EmailDeliveryStatus> {
    if (!this.emailSender.getDeliveryStatus) {
      this.logger.error('Durable email delivery status is unavailable', {
        codeTag: 'EmailRequestedEventHandler',
        messageIdentifier,
      })
      throw new Error('Durable email delivery status is unavailable')
    }

    try {
      return await this.emailSender.getDeliveryStatus(deliveryId)
    } catch {
      this.logger.error('Durable email delivery status could not be read', {
        codeTag: 'EmailRequestedEventHandler',
        messageIdentifier,
      })
      throw new Error('Durable email delivery status could not be read')
    }
  }

  private async finalizeDurableBackupBatch(
    userUuid: string,
    batch: PendingEmailBackupBatch,
    state: EmailBackupDeliveryState,
    messageIdentifier: string,
  ): Promise<void> {
    const references = batch.deliveries.flatMap((delivery) => {
      return delivery.reference ? [delivery.reference] : []
    })
    for (const reference of references) {
      try {
        await this.backupAttachmentStorage.markDelivered(reference)
      } catch {
        this.logger.error('Provider-accepted email backup attachment could not be receipted', {
          codeTag: 'EmailRequestedEventHandler',
          messageIdentifier,
        })
        throw new Error('Email backup delivery receipt could not be persisted')
      }
    }

    const deliveredAt = this.nowInMilliseconds()
    const completedState = recordCompletedEmailBackupBatch(state, batch.batchId, deliveredAt)

    await this.recordDeliveryState(userUuid, state, completedState, messageIdentifier, deliveredAt)
    await this.cleanupDeliveredAttachments(references, messageIdentifier)
  }

  private markQueueAccepted(batch: PendingEmailBackupBatch, deliveryIndex: number): PendingEmailBackupBatch {
    return {
      ...batch,
      deliveries: batch.deliveries.map((delivery, index) => {
        return index === deliveryIndex ? { ...delivery, queueAccepted: true } : delivery
      }),
    }
  }

  private async readDeliveryState(userUuid: string): Promise<EmailBackupDeliveryState> {
    if (this.emailBackupStateRepository) {
      try {
        const result = await this.emailBackupStateRepository.runExclusive(userUuid, (state) => ({ result: state }))
        if (result.status === 'user-not-found') {
          throw new Error('Email backup user no longer exists')
        }

        return result.value
      } catch {
        this.logger.error('Email backup delivery state could not be read', {
          codeTag: 'EmailRequestedEventHandler',
        })
        throw new Error('Email backup delivery state could not be read')
      }
    }

    const result = await this.getSetting.execute({
      userUuid,
      settingName: SettingName.NAMES.EmailBackupDeliveryState,
      allowSensitiveRetrieval: true,
      decrypted: true,
    })
    if (result.isFailed()) {
      return emptyEmailBackupDeliveryState()
    }

    try {
      return parseEmailBackupDeliveryState(result.getValue().decryptedValue ?? '')
    } catch {
      this.logger.error('Email backup delivery state is invalid', {
        codeTag: 'EmailRequestedEventHandler',
      })
      throw new Error('Email backup delivery state is invalid')
    }
  }

  private async recordBatchCompleted(
    userUuid: string,
    batchId: string,
    deliveredAt: number,
    state: EmailBackupDeliveryState,
    messageIdentifier: string,
  ): Promise<void> {
    await this.recordDeliveryState(
      userUuid,
      state,
      recordCompletedEmailBackupBatch(state, batchId, deliveredAt),
      messageIdentifier,
      deliveredAt,
    )
  }

  private async recordDeliveryState(
    userUuid: string,
    previousState: EmailBackupDeliveryState,
    nextState: EmailBackupDeliveryState,
    messageIdentifier: string,
    lastSentAt?: number,
  ): Promise<void> {
    if (this.emailBackupStateRepository) {
      try {
        const result = await this.emailBackupStateRepository.runExclusive(userUuid, (currentState) => ({
          result: undefined,
          deliveryState: applyEmailBackupStatePatch(currentState, previousState, nextState),
          ...(lastSentAt !== undefined ? { lastSentAt } : {}),
        }))
        if (result.status === 'user-not-found') {
          throw new Error('Email backup user no longer exists')
        }
        return
      } catch {
        this.logger.error('Email backup delivery state could not be recorded', {
          codeTag: 'EmailRequestedEventHandler',
          messageIdentifier,
        })
        throw new Error('Email backup bookkeeping could not be persisted')
      }
    }

    await this.setServerSetting(
      userUuid,
      SettingName.NAMES.EmailBackupDeliveryState,
      serializeEmailBackupDeliveryState(nextState),
      'Email backup delivery state could not be recorded',
      messageIdentifier,
    )
    if (lastSentAt !== undefined) {
      await this.recordLastSent(userUuid, lastSentAt, messageIdentifier)
    }
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

  private nowInMilliseconds(): number {
    return this.timer.convertMicrosecondsToMilliseconds(this.timer.getTimestampInMicroseconds())
  }

  private logBackupDeliveryBlocked(messageIdentifier: string, batchId: string, status: string): void {
    this.logger.error('Email backup durable delivery is blocked', {
      codeTag: 'EmailRequestedEventHandler',
      messageIdentifier,
      batchId,
      status,
    })
  }

  private logRejected(reason: string, messageIdentifier: string): void {
    this.logger.error(`Email request rejected because its ${reason}`, {
      codeTag: 'EmailRequestedEventHandler',
      messageIdentifier,
    })
  }

  private logAccepted(messageIdentifier: string, terminal: boolean): void {
    this.logger.info(
      terminal ? 'Email request accepted by the provider' : 'Email request accepted by the durable queue',
      {
        codeTag: 'EmailRequestedEventHandler',
        messageIdentifier,
      },
    )
  }
}

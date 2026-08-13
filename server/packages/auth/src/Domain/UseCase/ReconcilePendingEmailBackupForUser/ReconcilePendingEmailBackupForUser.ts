import { Result, SettingName, UseCaseInterface } from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'
import { Logger } from 'winston'

import { BackupAttachmentStorageInterface } from '../../Email/BackupAttachmentStorageInterface'
import {
  EmailBackupDeliveryState,
  PendingEmailBackupBatch,
  emptyEmailBackupDeliveryState,
  parseEmailBackupDeliveryState,
  recordCompletedEmailBackupBatch,
  serializeEmailBackupDeliveryState,
} from '../../Email/EmailBackupDeliveryState'
import { applyEmailBackupStatePatch } from '../../Email/EmailBackupStatePatch'
import { EmailBackupStateRepositoryInterface } from '../../Email/EmailBackupStateRepositoryInterface'
import { EmailDeliveryStatus, EmailSenderInterface } from '../../Email/EmailSenderInterface'
import { GetSetting } from '../GetSetting/GetSetting'
import { SetSettingValue } from '../SetSettingValue/SetSettingValue'

export type PendingEmailBackupReconciliationStatus = 'none' | 'pending' | 'blocked' | 'completed'

export interface ReconcilePendingEmailBackupForUserDTO {
  userUuid: string
}

export class ReconcilePendingEmailBackupForUser implements UseCaseInterface<PendingEmailBackupReconciliationStatus> {
  private static readonly BLOCKED_STATUSES = new Set<EmailDeliveryStatus>([
    'dead',
    'quarantined',
    'discarded',
    'superseded',
    'missing',
  ])

  constructor(
    private readonly emailSender: EmailSenderInterface,
    private readonly backupAttachmentStorage: BackupAttachmentStorageInterface,
    private readonly getSetting: GetSetting,
    private readonly setSettingValue: SetSettingValue,
    private readonly timer: TimerInterface,
    private readonly logger: Logger,
    private readonly emailBackupStateRepository?: EmailBackupStateRepositoryInterface,
  ) {}

  async execute(dto: ReconcilePendingEmailBackupForUserDTO): Promise<Result<PendingEmailBackupReconciliationStatus>> {
    const stateResult = await this.readState(dto.userUuid)
    if (stateResult.isFailed()) {
      return Result.fail('Email backup delivery state could not be read')
    }

    const state = stateResult.getValue()
    if (state.pending.length === 0) {
      return Result.ok('none')
    }

    if (this.emailSender.acceptanceMode !== 'durable-queue' || !this.emailSender.getDeliveryStatus) {
      this.logger.error('Pending email backup cannot be reconciled without durable delivery status', {
        codeTag: 'ReconcilePendingEmailBackupForUser',
        userId: dto.userUuid,
      })
      return Result.ok('blocked')
    }

    const acceptedBatches: PendingEmailBackupBatch[] = []
    let hasPending = false
    let hasBlocked = false
    for (const batch of state.pending) {
      const statuses: EmailDeliveryStatus[] = []
      try {
        for (const delivery of batch.deliveries) {
          statuses.push(await this.emailSender.getDeliveryStatus(delivery.deliveryId))
        }
      } catch {
        this.logger.error('Pending email backup delivery status could not be read', {
          codeTag: 'ReconcilePendingEmailBackupForUser',
          userId: dto.userUuid,
          batchId: batch.batchId,
        })
        return Result.fail('Durable email delivery status could not be read')
      }

      if (statuses.every((status) => status === 'provider-accepted')) {
        acceptedBatches.push(batch)
        continue
      }

      const blockedStatus = statuses.find((status) => ReconcilePendingEmailBackupForUser.BLOCKED_STATUSES.has(status))
      if (blockedStatus) {
        hasBlocked = true
        this.logger.error('Pending email backup durable delivery is blocked', {
          codeTag: 'ReconcilePendingEmailBackupForUser',
          userId: dto.userUuid,
          batchId: batch.batchId,
          status: blockedStatus,
        })
      } else {
        hasPending = true
      }
    }

    if (acceptedBatches.length > 0) {
      const finalized = await this.finalizeAcceptedBatches(dto.userUuid, state, acceptedBatches)
      if (!finalized) {
        return Result.fail('Email backup delivery receipts could not be persisted')
      }
    }

    if (hasBlocked) {
      return Result.ok('blocked')
    }
    if (hasPending) {
      return Result.ok('pending')
    }

    return Result.ok('completed')
  }

  private async finalizeAcceptedBatches(
    userUuid: string,
    state: EmailBackupDeliveryState,
    acceptedBatches: PendingEmailBackupBatch[],
  ): Promise<boolean> {
    const references = acceptedBatches.flatMap((batch) =>
      batch.deliveries.flatMap((delivery) => (delivery.reference ? [delivery.reference] : [])),
    )
    try {
      for (const reference of references) {
        await this.backupAttachmentStorage.markDelivered(reference)
      }
    } catch {
      this.logger.error('Provider-accepted email backup attachment could not be receipted', {
        codeTag: 'ReconcilePendingEmailBackupForUser',
        userId: userUuid,
      })
      return false
    }

    const deliveredAt = this.timer.convertMicrosecondsToMilliseconds(this.timer.getTimestampInMicroseconds())
    let completedState = state
    for (const batch of acceptedBatches) {
      completedState = recordCompletedEmailBackupBatch(completedState, batch.batchId, deliveredAt)
    }

    if (this.emailBackupStateRepository) {
      try {
        const result = await this.emailBackupStateRepository.runExclusive(userUuid, (currentState) => ({
          result: undefined,
          deliveryState: applyEmailBackupStatePatch(currentState, state, completedState),
          lastSentAt: deliveredAt,
        }))
        if (result.status === 'user-not-found') {
          return false
        }
      } catch {
        this.logger.error('Email backup reconciliation bookkeeping could not be persisted', {
          codeTag: 'ReconcilePendingEmailBackupForUser',
          userId: userUuid,
        })
        return false
      }
    } else {
      if (!(await this.writeSetting(userUuid, SettingName.NAMES.EmailBackupLastSent, String(deliveredAt)))) {
        return false
      }
      if (
        !(await this.writeSetting(
          userUuid,
          SettingName.NAMES.EmailBackupDeliveryState,
          serializeEmailBackupDeliveryState(completedState),
        ))
      ) {
        return false
      }
    }

    for (const reference of references) {
      try {
        await this.backupAttachmentStorage.delete(reference)
      } catch {
        this.logger.error('Delivered email backup attachment could not be deleted', {
          codeTag: 'ReconcilePendingEmailBackupForUser',
          userId: userUuid,
        })
      }
    }

    return true
  }

  private async readState(userUuid: string): Promise<Result<EmailBackupDeliveryState>> {
    try {
      if (this.emailBackupStateRepository) {
        const result = await this.emailBackupStateRepository.runExclusive(userUuid, (state) => ({ result: state }))
        return result.status === 'available'
          ? Result.ok(result.value)
          : Result.fail('Email backup user no longer exists')
      }

      const result = await this.getSetting.execute({
        userUuid,
        settingName: SettingName.NAMES.EmailBackupDeliveryState,
        allowSensitiveRetrieval: true,
        decrypted: true,
      })
      if (result.isFailed()) {
        return Result.ok(emptyEmailBackupDeliveryState())
      }

      return Result.ok(parseEmailBackupDeliveryState(result.getValue().decryptedValue ?? ''))
    } catch {
      this.logger.error('Email backup delivery state is invalid or unavailable', {
        codeTag: 'ReconcilePendingEmailBackupForUser',
        userId: userUuid,
      })
      return Result.fail('Email backup delivery state is invalid or unavailable')
    }
  }

  private async writeSetting(userUuid: string, settingName: string, value: string): Promise<boolean> {
    try {
      const result = await this.setSettingValue.execute({
        userUuid,
        settingName,
        value,
        checkUserPermissions: false,
      })
      if (result.isFailed()) {
        throw new Error('Setting write was rejected')
      }

      return true
    } catch {
      this.logger.error('Email backup reconciliation bookkeeping could not be persisted', {
        codeTag: 'ReconcilePendingEmailBackupForUser',
        userId: userUuid,
        settingName,
      })
      return false
    }
  }
}

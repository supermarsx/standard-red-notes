import { Result, SettingName, UseCaseInterface } from '@standardnotes/domain-core'
import { NextcloudBackupFrequency } from '@standardnotes/settings'
import { TimerInterface } from '@standardnotes/time'
import { v4 as uuidv4 } from 'uuid'
import { Logger } from 'winston'

import { NextcloudBackupStateStore } from '../../Setting/NextcloudBackupStateStore'
import {
  NEXTCLOUD_BACKUP_IN_FLIGHT_TIMEOUT_MS,
  NextcloudBackupDeliveryState,
  nextFailureCount,
  nextNextcloudBackupRetryDelayMs,
} from '../../Setting/NextcloudBackupDeliveryState'
import { SettingRepositoryInterface } from '../../Setting/SettingRepositoryInterface'
import { TriggerNextcloudBackupForUser } from '../TriggerNextcloudBackupForUser/TriggerNextcloudBackupForUser'
import { isNextcloudBackupDue } from './NextcloudBackupDueCalculator'
import { TriggerNextcloudBackupForAllUsersDTO } from './TriggerNextcloudBackupForAllUsersDTO'

type SchedulerDecision =
  | { kind: 'dispatch'; requestUuid: string }
  | { kind: 'not-due' }
  | { kind: 'in-flight-or-backoff' }
  | { kind: 'expired' }

/**
 * Standard Red Notes: scheduled Nextcloud-backup trigger over the whole cohort of
 * users on a given frequency. The operator switch defaults OFF, and each user's
 * due check plus pending claim is one cross-process database transaction. Only
 * the process that commits the claim publishes after the transaction releases.
 */
export class TriggerNextcloudBackupForAllUsers implements UseCaseInterface<void> {
  private PAGING_LIMIT = 100

  constructor(
    private settingRepository: SettingRepositoryInterface,
    private triggerNextcloudBackupForUserUseCase: TriggerNextcloudBackupForUser,
    private stateStore: NextcloudBackupStateStore,
    private timer: TimerInterface,
    private logger: Logger,
    private nextcloudBackupsEnabled: boolean,
    private nextcloudBackupsEnabledOverride?: () => Promise<boolean | undefined>,
  ) {}

  async execute(dto: TriggerNextcloudBackupForAllUsersDTO): Promise<Result<void>> {
    const overrideEnabled = this.nextcloudBackupsEnabledOverride
      ? await this.nextcloudBackupsEnabledOverride()
      : undefined
    const enabled = overrideEnabled ?? this.nextcloudBackupsEnabled
    if (!enabled) {
      this.logger.info(
        'Scheduled Nextcloud backups are disabled by the operator (NEXTCLOUD_BACKUPS_ENABLED / admin server settings). Skipping.',
      )

      return Result.ok()
    }

    const nextcloudBackupFrequencySettingName = SettingName.create(
      SettingName.NAMES.NextcloudBackupFrequency,
    ).getValue()
    const allSettingsCount = await this.settingRepository.countAllByNameAndValue({
      name: nextcloudBackupFrequencySettingName,
      value: dto.backupFrequency,
    })

    this.logger.info(`Found ${allSettingsCount} users with Nextcloud backup frequency set to ${dto.backupFrequency}`)

    const nowMs = this.timer.convertMicrosecondsToMilliseconds(this.timer.getTimestampInMicroseconds())
    let failedUsers = 0
    let skippedNotDue = 0
    let skippedInFlightOrBackoff = 0
    const numberOfPages = Math.ceil(allSettingsCount / this.PAGING_LIMIT)

    for (let i = 0; i < numberOfPages; i++) {
      const settings = await this.settingRepository.findAllByNameAndValue({
        name: nextcloudBackupFrequencySettingName,
        value: dto.backupFrequency,
        offset: i * this.PAGING_LIMIT,
        limit: this.PAGING_LIMIT,
      })

      for (const setting of settings) {
        const userUuid = setting.props.userUuid.value
        const claim = await this.claimDueBackup(userUuid, dto.backupFrequency, nowMs)
        if (claim.status === 'unavailable') {
          this.logger.error('Skipped a Nextcloud backup because lifecycle state is unavailable.', {
            userId: userUuid,
          })
          failedUsers++
          continue
        }
        if (claim.status === 'user-not-found') {
          this.logger.info('Skipped a Nextcloud backup for a deleted user.', { userId: userUuid })
          continue
        }

        const decision = claim.value
        if (decision.kind === 'not-due') {
          skippedNotDue++
          continue
        }
        if (decision.kind === 'in-flight-or-backoff' || decision.kind === 'expired') {
          if (decision.kind === 'expired') {
            this.logger.warn('A Nextcloud backup request expired; retry is delayed.', {
              userId: userUuid,
            })
          }
          skippedInFlightOrBackoff++
          continue
        }

        // The claim transaction has committed and released before this call.
        // Never hold a database lock across SNS or direct-call event delivery.
        let result: Result<void>
        try {
          result = await this.triggerNextcloudBackupForUserUseCase.execute({
            userUuid,
            requestUuid: decision.requestUuid,
          })
        } catch {
          result = Result.fail('Nextcloud backup request publication failed')
        }
        if (result.isFailed()) {
          await this.recordDispatchFailure(userUuid, decision.requestUuid, nowMs)
          this.logger.error('Failed to dispatch a Nextcloud backup for a user.', { userId: userUuid })
          failedUsers++
        }
      }
    }

    this.logger.info(
      `Nextcloud backup trigger pass complete for frequency ${dto.backupFrequency}: ${skippedNotDue} skipped (not due), ${skippedInFlightOrBackoff} skipped (in flight/backoff), ${failedUsers} failed`,
    )

    if (failedUsers > 0) {
      this.logger.error(`Failed to trigger Nextcloud backup for ${failedUsers} users`)
    }

    return Result.ok()
  }

  private claimDueBackup(userUuid: string, frequency: string, nowMs: number) {
    return this.stateStore.runExclusive<SchedulerDecision>(
      userUuid,
      ({ deliveryState: persistedState, lastSuccessAt }) => {
        let state = persistedState
        let healed = false

        // A success and its state update now commit atomically. This healing path
        // remains for rows written by older versions during a rolling upgrade.
        if (state.activeRequest && lastSuccessAt !== null && state.activeRequest.requestedAt <= lastSuccessAt) {
          state = {
            ...state,
            activeRequest: null,
            consecutiveFailures: 0,
            retryNotBefore: null,
          }
          healed = true
        }

        if (!isNextcloudBackupDue(frequency as NextcloudBackupFrequency, lastSuccessAt, nowMs)) {
          return {
            result: { kind: 'not-due' },
            deliveryState: healed ? state : undefined,
          }
        }

        if (state.activeRequest) {
          if (nowMs < state.activeRequest.requestedAt + NEXTCLOUD_BACKUP_IN_FLIGHT_TIMEOUT_MS) {
            return { result: { kind: 'in-flight-or-backoff' } }
          }

          const consecutiveFailures = nextFailureCount(state.consecutiveFailures)
          return {
            result: { kind: 'expired' },
            deliveryState: {
              ...state,
              activeRequest: null,
              consecutiveFailures,
              retryNotBefore: nowMs + nextNextcloudBackupRetryDelayMs(consecutiveFailures),
            },
          }
        }

        if (state.retryNotBefore !== null && nowMs < state.retryNotBefore) {
          return { result: { kind: 'in-flight-or-backoff' } }
        }

        const requestUuid = uuidv4()
        return {
          result: { kind: 'dispatch', requestUuid },
          deliveryState: {
            ...state,
            activeRequest: { requestUuid, requestedAt: nowMs },
          },
        }
      },
    )
  }

  private async recordDispatchFailure(userUuid: string, requestUuid: string, nowMs: number): Promise<void> {
    await this.stateStore.runExclusive(userUuid, ({ deliveryState: state }) => {
      if (
        state.activeRequest?.requestUuid !== requestUuid ||
        state.completed.some((entry) => entry.requestUuid === requestUuid)
      ) {
        return { result: undefined }
      }

      const consecutiveFailures = nextFailureCount(state.consecutiveFailures)
      const failedState: NextcloudBackupDeliveryState = {
        ...state,
        activeRequest: null,
        consecutiveFailures,
        retryNotBefore: nowMs + nextNextcloudBackupRetryDelayMs(consecutiveFailures),
      }

      return { result: undefined, deliveryState: failedState }
    })
  }
}

import { Result, SettingName, UseCaseInterface } from '@standardnotes/domain-core'
import { NextcloudBackupFrequency } from '@standardnotes/settings'
import { TimerInterface } from '@standardnotes/time'
import { v4 as uuidv4 } from 'uuid'
import { TriggerNextcloudBackupForUser } from '../TriggerNextcloudBackupForUser/TriggerNextcloudBackupForUser'
import { SettingRepositoryInterface } from '../../Setting/SettingRepositoryInterface'
import { TriggerNextcloudBackupForAllUsersDTO } from './TriggerNextcloudBackupForAllUsersDTO'
import { isNextcloudBackupDue } from './NextcloudBackupDueCalculator'
import { Logger } from 'winston'
import {
  NEXTCLOUD_BACKUP_IN_FLIGHT_TIMEOUT_MS,
  NEXTCLOUD_BACKUP_MAX_RETRY_DELAY_MS,
  NextcloudBackupDeliveryState,
  appendNextcloudBackupCompletion,
  nextFailureCount,
  nextNextcloudBackupRetryDelayMs,
} from '../../Setting/NextcloudBackupDeliveryState'
import { NextcloudBackupStateStore } from '../../Setting/NextcloudBackupStateStore'

const MAX_SCHEDULER_CLOCK_SKEW_MS = 5 * 60 * 1_000

/**
 * Standard Red Notes: scheduled Nextcloud-backup trigger over the whole cohort of
 * users on a given frequency. Mirrors TriggerEmailBackupForAllUsers. The operator
 * switch (NEXTCLOUD_BACKUPS_ENABLED) defaults OFF so a fresh install never uploads.
 * Per-user completeness (URL + app password + frequency) is enforced downstream in
 * TriggerNextcloudBackupForUser.
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
    // Standard Red Notes: OPTIONAL runtime override of the master gate. Resolves
    // the admin-persisted server-settings overlay (written gateway-side via
    // PUT /v1/admin/server-settings, read here through the shared
    // SERVER_SETTINGS_PATH file). PRECEDENCE: a persisted admin value WINS over
    // the boot-time env boolean above; `undefined` (no override persisted / no
    // shared file) falls back to the env value. Consulted per execute() so an
    // admin toggle takes effect on the next scheduled run without a restart.
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

        // Per-user due-calculation: respect the last-run timestamp so a single
        // (more-frequent) cron can serve daily/weekly/monthly and catch up missed
        // runs. dto.backupFrequency selects the cohort; the calculator decides if
        // this specific user is actually due now.
        const lastSuccessRead = await this.stateStore.readLastSuccessAt(userUuid)
        const stateRead = await this.stateStore.readDeliveryState(userUuid)
        if (lastSuccessRead.status === 'unavailable' || stateRead.status === 'unavailable') {
          this.logger.error('Skipped a Nextcloud backup because lifecycle state is unavailable.', {
            userId: userUuid,
          })
          failedUsers++
          continue
        }

        const lastSuccessAtMs = lastSuccessRead.value
        let state = stateRead.value
        if (!this.hasPlausibleSchedulingTimestamps(state, lastSuccessAtMs, nowMs)) {
          this.logger.error('Skipped a Nextcloud backup because lifecycle timestamps are invalid.', {
            userId: userUuid,
          })
          failedUsers++
          continue
        }

        // A prior success can be durable even if its follow-up state write was
        // interrupted. Heal that stale active marker before making a due decision.
        if (state.activeRequest && lastSuccessAtMs !== null && state.activeRequest.requestedAt <= lastSuccessAtMs) {
          state = {
            ...state,
            activeRequest: null,
            consecutiveFailures: 0,
            retryNotBefore: null,
          }
          if (!(await this.stateStore.writeDeliveryState(userUuid, state))) {
            failedUsers++
            continue
          }
        }

        if (!isNextcloudBackupDue(dto.backupFrequency as NextcloudBackupFrequency, lastSuccessAtMs, nowMs)) {
          skippedNotDue++
          continue
        }

        if (state.activeRequest) {
          if (nowMs < state.activeRequest.requestedAt + NEXTCLOUD_BACKUP_IN_FLIGHT_TIMEOUT_MS) {
            skippedInFlightOrBackoff++
            continue
          }

          const consecutiveFailures = nextFailureCount(state.consecutiveFailures)
          const expiredState: NextcloudBackupDeliveryState = {
            ...state,
            activeRequest: null,
            consecutiveFailures,
            retryNotBefore: nowMs + nextNextcloudBackupRetryDelayMs(consecutiveFailures),
          }
          if (!(await this.stateStore.writeDeliveryState(userUuid, expiredState))) {
            failedUsers++
            continue
          }

          this.logger.warn('A Nextcloud backup request expired; retry is delayed.', {
            userId: userUuid,
          })
          skippedInFlightOrBackoff++
          continue
        }

        if (state.retryNotBefore !== null && nowMs < state.retryNotBefore) {
          skippedInFlightOrBackoff++
          continue
        }

        const requestUuid = uuidv4()
        const pendingState: NextcloudBackupDeliveryState = {
          ...state,
          activeRequest: { requestUuid, requestedAt: nowMs },
        }
        if (!(await this.stateStore.writeDeliveryState(userUuid, pendingState))) {
          failedUsers++
          continue
        }

        let result: Result<void>
        try {
          result = await this.triggerNextcloudBackupForUserUseCase.execute({ userUuid, requestUuid })
        } catch {
          result = Result.fail('Nextcloud backup request publication failed')
        }
        if (result.isFailed()) {
          await this.recordDispatchFailure(userUuid, requestUuid, nowMs)
          this.logger.error('Failed to dispatch a Nextcloud backup for a user.', { userId: userUuid })
          failedUsers++
          continue
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

  private async recordDispatchFailure(userUuid: string, requestUuid: string, nowMs: number): Promise<void> {
    const stateRead = await this.stateStore.readDeliveryState(userUuid)
    if (stateRead.status === 'unavailable') {
      return
    }
    const state = stateRead.value
    if (
      state.activeRequest?.requestUuid !== requestUuid ||
      state.completed.some((entry) => entry.requestUuid === requestUuid)
    ) {
      return
    }

    const consecutiveFailures = nextFailureCount(state.consecutiveFailures)
    await this.stateStore.writeDeliveryState(userUuid, {
      ...state,
      activeRequest: null,
      consecutiveFailures,
      retryNotBefore: nowMs + nextNextcloudBackupRetryDelayMs(consecutiveFailures),
      completed: appendNextcloudBackupCompletion(state, {
        requestUuid,
        outcome: 'failed',
        completedAt: nowMs,
      }),
    })
  }

  private hasPlausibleSchedulingTimestamps(
    state: NextcloudBackupDeliveryState,
    lastSuccessAtMs: number | null,
    nowMs: number,
  ): boolean {
    if (lastSuccessAtMs !== null && lastSuccessAtMs > nowMs + MAX_SCHEDULER_CLOCK_SKEW_MS) {
      return false
    }
    if (state.activeRequest && state.activeRequest.requestedAt > nowMs + MAX_SCHEDULER_CLOCK_SKEW_MS) {
      return false
    }
    if (
      state.retryNotBefore !== null &&
      state.retryNotBefore > nowMs + NEXTCLOUD_BACKUP_MAX_RETRY_DELAY_MS + MAX_SCHEDULER_CLOCK_SKEW_MS
    ) {
      return false
    }

    return true
  }
}

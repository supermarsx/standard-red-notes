import { Result, SettingName, UseCaseInterface } from '@standardnotes/domain-core'
import { NextcloudBackupFrequency } from '@standardnotes/settings'
import { TimerInterface } from '@standardnotes/time'
import { TriggerNextcloudBackupForUser } from '../TriggerNextcloudBackupForUser/TriggerNextcloudBackupForUser'
import { SettingRepositoryInterface } from '../../Setting/SettingRepositoryInterface'
import { GetSetting } from '../GetSetting/GetSetting'
import { SetSettingValue } from '../SetSettingValue/SetSettingValue'
import { TriggerNextcloudBackupForAllUsersDTO } from './TriggerNextcloudBackupForAllUsersDTO'
import { isNextcloudBackupDue } from './NextcloudBackupDueCalculator'
import { Logger } from 'winston'

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
    private getSetting: GetSetting,
    private setSettingValue: SetSettingValue,
    private timer: TimerInterface,
    private logger: Logger,
    private nextcloudBackupsEnabled: boolean,
  ) {}

  async execute(dto: TriggerNextcloudBackupForAllUsersDTO): Promise<Result<void>> {
    if (!this.nextcloudBackupsEnabled) {
      this.logger.info(
        'Scheduled Nextcloud backups are disabled by the operator (NEXTCLOUD_BACKUPS_ENABLED). Skipping.',
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
        const lastRunAtMs = await this.getLastRunAtMs(userUuid)
        if (!isNextcloudBackupDue(dto.backupFrequency as NextcloudBackupFrequency, lastRunAtMs, nowMs)) {
          skippedNotDue++
          continue
        }

        const result = await this.triggerNextcloudBackupForUserUseCase.execute({ userUuid })
        /* istanbul ignore next */
        if (result.isFailed()) {
          this.logger.error(`Failed to trigger Nextcloud backup for user: ${result.getError()}`, { userId: userUuid })
          failedUsers++
          continue
        }

        await this.recordLastRun(userUuid, nowMs)
      }
    }

    this.logger.info(
      `Nextcloud backup trigger pass complete for frequency ${dto.backupFrequency}: ${skippedNotDue} skipped (not due), ${failedUsers} failed`,
    )

    /* istanbul ignore next */
    if (failedUsers > 0) {
      this.logger.error(`Failed to trigger Nextcloud backup for ${failedUsers} users`)
    }

    return Result.ok()
  }

  private async getLastRunAtMs(userUuid: string): Promise<number | null> {
    const result = await this.getSetting.execute({
      userUuid,
      settingName: SettingName.NAMES.NextcloudBackupLastRun,
      allowSensitiveRetrieval: false,
      decrypted: true,
    })

    if (result.isFailed()) {
      return null
    }

    const value = result.getValue().decryptedValue
    if (!value) {
      return null
    }

    const parsed = Number.parseInt(value, 10)

    return Number.isNaN(parsed) ? null : parsed
  }

  private async recordLastRun(userUuid: string, nowMs: number): Promise<void> {
    const result = await this.setSettingValue.execute({
      settingName: SettingName.NAMES.NextcloudBackupLastRun,
      value: String(nowMs),
      userUuid,
      // Server-side bookkeeping: bypass the client-mutability permission check.
      checkUserPermissions: false,
    })

    /* istanbul ignore next */
    if (result.isFailed()) {
      this.logger.error(`Failed to record Nextcloud backup last-run for user ${userUuid}: ${result.getError()}`)
    }
  }
}

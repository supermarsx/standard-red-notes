import { Result, SettingName, UseCaseInterface } from '@standardnotes/domain-core'
import { EmailBackupFrequency } from '@standardnotes/settings'
import { TimerInterface } from '@standardnotes/time'
import { TriggerEmailBackupForUser } from '../TriggerEmailBackupForUser/TriggerEmailBackupForUser'
import { SettingRepositoryInterface } from '../../Setting/SettingRepositoryInterface'
import { GetSetting } from '../GetSetting/GetSetting'
import { TriggerEmailBackupForAllUsersDTO } from './TriggerEmailBackupForAllUsersDTO'
import { isEmailBackupDue } from './EmailBackupDueCalculator'
import { Logger } from 'winston'

export class TriggerEmailBackupForAllUsers implements UseCaseInterface<void> {
  private PAGING_LIMIT = 100

  constructor(
    private settingRepository: SettingRepositoryInterface,
    private triggerEmailBackupForUserUseCase: TriggerEmailBackupForUser,
    private getSetting: GetSetting,
    private timer: TimerInterface,
    private logger: Logger,
    /**
     * Operator switch: scheduled email backups only run when the operator has
     * explicitly enabled the feature (EMAIL_BACKUPS_ENABLED) AND email delivery is
     * configured (SMTP). Both default to off so a fresh install never emails.
     */
    private emailBackupsEnabled: boolean,
    private emailDeliveryConfigured: boolean,
  ) {}

  async execute(dto: TriggerEmailBackupForAllUsersDTO): Promise<Result<void>> {
    if (!this.emailBackupsEnabled) {
      this.logger.info('Scheduled email backups are disabled by the operator (EMAIL_BACKUPS_ENABLED). Skipping.')

      return Result.ok()
    }

    if (!this.emailDeliveryConfigured) {
      this.logger.warn(
        'Scheduled email backups are enabled but email delivery (SMTP) is not configured. Skipping to avoid generating backups that cannot be delivered.',
      )

      return Result.ok()
    }

    const emailBackupFrequencySettingName = SettingName.create(SettingName.NAMES.EmailBackupFrequency).getValue()

    const allSettingsCount = await this.settingRepository.countAllByNameAndValue({
      name: emailBackupFrequencySettingName,
      value: dto.backupFrequency,
    })

    this.logger.info(`Found ${allSettingsCount} users with email backup frequency set to ${dto.backupFrequency}`)

    const nowMs = this.timer.convertMicrosecondsToMilliseconds(this.timer.getTimestampInMicroseconds())

    let failedUsers = 0
    let skippedNotDue = 0
    const numberOfPages = Math.ceil(allSettingsCount / this.PAGING_LIMIT)
    for (let i = 0; i < numberOfPages; i++) {
      const settings = await this.settingRepository.findAllByNameAndValue({
        name: emailBackupFrequencySettingName,
        value: dto.backupFrequency,
        offset: i * this.PAGING_LIMIT,
        limit: this.PAGING_LIMIT,
      })

      for (const setting of settings) {
        const userUuid = setting.props.userUuid.value

        // Per-user due-calculation: respect the last-sent timestamp so a single
        // (more-frequent) cron can serve daily/weekly/monthly and catch up missed
        // runs. dto.backupFrequency selects the cohort; the calculator decides if
        // this specific user is actually due now.
        const lastSentAtMs = await this.getLastSentAtMs(userUuid)
        if (!isEmailBackupDue(dto.backupFrequency as EmailBackupFrequency, lastSentAtMs, nowMs)) {
          skippedNotDue++
          continue
        }

        const result = await this.triggerEmailBackupForUserUseCase.execute({ userUuid })
        if (result.isFailed()) {
          this.logger.error('Failed to trigger an email backup for a user.', { userId: userUuid })
          failedUsers++
          continue
        }
      }
    }

    this.logger.info(
      `Email backup trigger pass complete for frequency ${dto.backupFrequency}: ${skippedNotDue} skipped (not due), ${failedUsers} failed`,
    )

    if (failedUsers > 0) {
      this.logger.error(`Failed to trigger email backup for ${failedUsers} users`)
    }

    return Result.ok()
  }

  private async getLastSentAtMs(userUuid: string): Promise<number | null> {
    const result = await this.getSetting.execute({
      userUuid,
      settingName: SettingName.NAMES.EmailBackupLastSent,
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
}

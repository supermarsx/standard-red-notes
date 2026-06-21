import { Result, SettingName, UseCaseInterface, Uuid } from '@standardnotes/domain-core'
import { NextcloudBackupFrequency } from '@standardnotes/settings'

import { TriggerNextcloudBackupForUserDTO } from './TriggerNextcloudBackupForUserDTO'
import { GetUserKeyParams } from '../GetUserKeyParams/GetUserKeyParams'
import { GetSetting } from '../GetSetting/GetSetting'
import { DomainEventPublisherInterface } from '@standardnotes/domain-events'
import { DomainEventFactoryInterface } from '../../Event/DomainEventFactoryInterface'

/**
 * Standard Red Notes: per-user trigger for a scheduled Nextcloud backup.
 *
 * Mirrors TriggerEmailBackupForUser, but the per-user gate is SMTP-style
 * COMPLETENESS rather than a role permission: the user must have a recurring
 * frequency (daily|weekly|monthly), a destination URL, and an app password set.
 * This use case resolves those settings auth-side (decrypting the SENSITIVE app
 * password), fetches the user's key params, and publishes a
 * NEXTCLOUD_BACKUP_REQUESTED event carrying the destination + credential so the
 * syncing-server handler (which owns item access) can perform the WebDAV upload.
 */
export class TriggerNextcloudBackupForUser implements UseCaseInterface<void> {
  constructor(
    private getUserKeyParamsUseCase: GetUserKeyParams,
    private getSetting: GetSetting,
    private domainEventPublisher: DomainEventPublisherInterface,
    private domainEventFactory: DomainEventFactoryInterface,
  ) {}

  async execute(dto: TriggerNextcloudBackupForUserDTO): Promise<Result<void>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(userUuidOrError.getError())
    }
    const userUuid = userUuidOrError.getValue()

    const frequency = await this.getUnsensitiveSetting(userUuid.value, SettingName.NAMES.NextcloudBackupFrequency)
    if (frequency === null || !this.isRecurringFrequency(frequency)) {
      return Result.fail(`User ${userUuid.value} does not have a recurring Nextcloud backup frequency configured`)
    }

    const url = await this.getUnsensitiveSetting(userUuid.value, SettingName.NAMES.NextcloudBackupUrl)
    if (url === null || url.trim() === '') {
      return Result.fail(`User ${userUuid.value} does not have a Nextcloud backup URL configured`)
    }

    const appPassword = await this.getSensitiveSetting(userUuid.value, SettingName.NAMES.NextcloudBackupAppPassword)
    if (appPassword === null || appPassword.trim() === '') {
      return Result.fail(`User ${userUuid.value} does not have a Nextcloud backup app password configured`)
    }

    // Folder is optional; default to an empty path (upload to the user's root).
    const folder = (await this.getUnsensitiveSetting(userUuid.value, SettingName.NAMES.NextcloudBackupFolder)) ?? ''

    const keyParamsResponse = await this.getUserKeyParamsUseCase.execute({
      userUuid: userUuid.value,
      authenticated: false,
    })

    await this.domainEventPublisher.publish(
      this.domainEventFactory.createNextcloudBackupRequestedEvent({
        userUuid: userUuid.value,
        keyParams: keyParamsResponse.keyParams,
        nextcloudUrl: url,
        nextcloudFolder: folder,
        nextcloudAppPassword: appPassword,
      }),
    )

    return Result.ok()
  }

  private isRecurringFrequency(value: string): boolean {
    return (
      value === NextcloudBackupFrequency.Daily ||
      value === NextcloudBackupFrequency.Weekly ||
      value === NextcloudBackupFrequency.Monthly
    )
  }

  private async getUnsensitiveSetting(userUuid: string, settingName: string): Promise<string | null> {
    const result = await this.getSetting.execute({
      userUuid,
      settingName,
      allowSensitiveRetrieval: false,
      decrypted: true,
    })

    if (result.isFailed()) {
      return null
    }

    return result.getValue().decryptedValue ?? null
  }

  private async getSensitiveSetting(userUuid: string, settingName: string): Promise<string | null> {
    const result = await this.getSetting.execute({
      userUuid,
      settingName,
      allowSensitiveRetrieval: true,
      decrypted: true,
    })

    if (result.isFailed()) {
      return null
    }

    return result.getValue().decryptedValue ?? null
  }
}

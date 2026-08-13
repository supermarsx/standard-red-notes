import { DomainEventPublisherInterface } from '@standardnotes/domain-events'
import { EmailLevel, Result, SettingName, UseCaseInterface, Uuid } from '@standardnotes/domain-core'
import { EmailBackupFrequency, LogSessionUserAgentOption } from '@standardnotes/settings'

import { TriggerPostSettingUpdateActionsDTO } from './TriggerPostSettingUpdateActionsDTO'
import { cancelDurableEmailDelivery } from '../../Email/DurableEmailCancellation'
import { createEmailReminderDeliveryId } from '../../Email/EmailDeliveryId'
import { EmailSenderInterface } from '../../Email/EmailSenderInterface'
import { EmailReminderRepositoryInterface } from '../../EmailReminder/EmailReminderRepositoryInterface'
import { DomainEventFactoryInterface } from '../../Event/DomainEventFactoryInterface'
import { TriggerEmailBackupForUser } from '../TriggerEmailBackupForUser/TriggerEmailBackupForUser'
import { GenerateRecoveryCodes } from '../GenerateRecoveryCodes/GenerateRecoveryCodes'

export class TriggerPostSettingUpdateActions implements UseCaseInterface<void> {
  private readonly emailSettingToSubscriptionRejectionLevelMap: Map<string, string> = new Map([
    [SettingName.NAMES.MuteMarketingEmails, EmailLevel.LEVELS.Marketing],
    [SettingName.NAMES.MuteSignInEmails, EmailLevel.LEVELS.SignIn],
  ])

  constructor(
    private domainEventPublisher: DomainEventPublisherInterface,
    private domainEventFactory: DomainEventFactoryInterface,
    private triggerEmailBackupForUser: TriggerEmailBackupForUser,
    private generateRecoveryCodes: GenerateRecoveryCodes,
    private emailReminderRepository: EmailReminderRepositoryInterface,
    private emailReminderSender: EmailSenderInterface,
  ) {}

  async execute(dto: TriggerPostSettingUpdateActionsDTO): Promise<Result<void>> {
    if (this.isChangingMuteEmailsSetting(dto.updatedSettingName)) {
      await this.triggerEmailSubscriptionChange(dto.userEmail, dto.updatedSettingName, dto.unencryptedValue)
    }

    if (this.isEnablingEmailBackupSetting(dto.updatedSettingName, dto.unencryptedValue)) {
      await this.triggerEmailBackupForUser.execute({
        userUuid: dto.userUuid,
      })
    }

    if (this.isDisablingSessionUserAgentLogging(dto.updatedSettingName, dto.unencryptedValue)) {
      await this.triggerSessionUserAgentCleanup(dto.userEmail, dto.userUuid)
    }

    if (this.isEnablingMFASetting(dto.updatedSettingName, dto.unencryptedValue)) {
      await this.generateRecoveryCodes.execute({
        userUuid: dto.userUuid,
      })
    }

    if (this.isDisablingEmailRemindersSetting(dto.updatedSettingName, dto.unencryptedValue)) {
      const cancellationResult = await this.cancelPendingEmailReminders(dto.userUuid)
      if (cancellationResult.isFailed()) {
        return cancellationResult
      }
    }

    return Result.ok()
  }

  private isChangingMuteEmailsSetting(settingName: string): boolean {
    return [SettingName.NAMES.MuteMarketingEmails, SettingName.NAMES.MuteSignInEmails].includes(settingName)
  }

  private isEnablingEmailBackupSetting(settingName: string, newValue: string | null): boolean {
    return (
      settingName === SettingName.NAMES.EmailBackupFrequency &&
      [EmailBackupFrequency.Daily, EmailBackupFrequency.Weekly].includes(newValue as EmailBackupFrequency)
    )
  }

  private isEnablingMFASetting(settingName: string, newValue: string | null): boolean {
    return settingName === SettingName.NAMES.MfaSecret && newValue !== null
  }

  private isDisablingSessionUserAgentLogging(settingName: string, newValue: string | null): boolean {
    return SettingName.NAMES.LogSessionUserAgent === settingName && LogSessionUserAgentOption.Disabled === newValue
  }

  private isDisablingEmailRemindersSetting(settingName: string, newValue: string | null): boolean {
    return settingName === SettingName.NAMES.EmailRemindersEnabled && newValue !== 'true'
  }

  private async cancelPendingEmailReminders(userUuidValue: string): Promise<Result<void>> {
    if (this.emailReminderSender.acceptanceMode !== 'durable-queue') {
      return Result.ok()
    }

    const userUuidOrError = Uuid.create(userUuidValue)
    if (userUuidOrError.isFailed()) {
      return Result.fail('Could not cancel pending email reminders.')
    }

    try {
      const reminders = await this.emailReminderRepository.findByUserUuid(userUuidOrError.getValue())
      let cancellationIncomplete = false

      for (const reminder of reminders) {
        if (reminder.props.sent) {
          continue
        }
        try {
          const cancellation = await cancelDurableEmailDelivery(
            this.emailReminderSender,
            createEmailReminderDeliveryId(reminder.id.toString()),
          )
          if (cancellation === 'in-flight') {
            cancellationIncomplete = true
          }
        } catch {
          cancellationIncomplete = true
        }
      }

      return cancellationIncomplete
        ? Result.fail('Could not cancel every pending email reminder delivery.')
        : Result.ok()
    } catch {
      return Result.fail('Could not cancel pending email reminders.')
    }
  }

  private async triggerEmailSubscriptionChange(
    userEmail: string,
    settingName: string,
    unencryptedValue: string | null,
  ): Promise<void> {
    await this.domainEventPublisher.publish(
      this.domainEventFactory.createMuteEmailsSettingChangedEvent({
        username: userEmail,
        mute: unencryptedValue === 'muted',
        emailSubscriptionRejectionLevel: this.emailSettingToSubscriptionRejectionLevelMap.get(settingName) as string,
      }),
    )
  }

  private async triggerSessionUserAgentCleanup(userEmail: string, userUuid: string) {
    await this.domainEventPublisher.publish(
      this.domainEventFactory.createUserDisabledSessionUserAgentLoggingEvent({
        userUuid,
        email: userEmail,
      }),
    )
  }
}

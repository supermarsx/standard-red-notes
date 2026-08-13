import {
  DomainEventPublisherInterface,
  EmailBackupRequestedEvent,
  MuteEmailsSettingChangedEvent,
  UserDisabledSessionUserAgentLoggingEvent,
} from '@standardnotes/domain-events'
import { EmailBackupFrequency, LogSessionUserAgentOption, MuteMarketingEmailsOption } from '@standardnotes/settings'
import { SettingName, Result, UniqueEntityId } from '@standardnotes/domain-core'

import { GenerateRecoveryCodes } from '../GenerateRecoveryCodes/GenerateRecoveryCodes'
import { TriggerPostSettingUpdateActions } from './TriggerPostSettingUpdateActions'
import { DomainEventFactoryInterface } from '../../Event/DomainEventFactoryInterface'
import { TriggerEmailBackupForUser } from '../TriggerEmailBackupForUser/TriggerEmailBackupForUser'
import { EmailReminder } from '../../EmailReminder/EmailReminder'
import { EmailReminderRepositoryInterface } from '../../EmailReminder/EmailReminderRepositoryInterface'
import { createEmailReminderDeliveryId } from '../../Email/EmailDeliveryId'
import { EmailSenderInterface } from '../../Email/EmailSenderInterface'

describe('TriggerPostSettingUpdateActions', () => {
  let domainEventPublisher: DomainEventPublisherInterface
  let domainEventFactory: DomainEventFactoryInterface
  let triggerEmailBackupForUser: TriggerEmailBackupForUser
  let generateRecoveryCodes: GenerateRecoveryCodes
  let emailReminderRepository: EmailReminderRepositoryInterface
  let emailReminderSender: EmailSenderInterface

  const createUseCase = () =>
    new TriggerPostSettingUpdateActions(
      domainEventPublisher,
      domainEventFactory,
      triggerEmailBackupForUser,
      generateRecoveryCodes,
      emailReminderRepository,
      emailReminderSender,
    )

  beforeEach(() => {
    generateRecoveryCodes = {} as jest.Mocked<GenerateRecoveryCodes>
    generateRecoveryCodes.execute = jest.fn().mockReturnValue(Result.ok())

    triggerEmailBackupForUser = {} as jest.Mocked<TriggerEmailBackupForUser>
    triggerEmailBackupForUser.execute = jest.fn().mockReturnValue(Result.ok())

    domainEventPublisher = {} as jest.Mocked<DomainEventPublisherInterface>
    domainEventPublisher.publish = jest.fn()

    domainEventFactory = {} as jest.Mocked<DomainEventFactoryInterface>
    domainEventFactory.createEmailBackupRequestedEvent = jest
      .fn()
      .mockReturnValue({} as jest.Mocked<EmailBackupRequestedEvent>)
    domainEventFactory.createUserDisabledSessionUserAgentLoggingEvent = jest
      .fn()
      .mockReturnValue({} as jest.Mocked<UserDisabledSessionUserAgentLoggingEvent>)
    domainEventFactory.createMuteEmailsSettingChangedEvent = jest
      .fn()
      .mockReturnValue({} as jest.Mocked<MuteEmailsSettingChangedEvent>)

    emailReminderRepository = {} as jest.Mocked<EmailReminderRepositoryInterface>
    emailReminderRepository.findByUserUuid = jest.fn().mockResolvedValue([])

    emailReminderSender = {
      acceptanceMode: 'provider',
      isConfigured: jest.fn().mockReturnValue(true),
      sendEmail: jest.fn(),
    }
  })

  it('should trigger session cleanup if user is disabling session user agent logging', async () => {
    await createUseCase().execute({
      updatedSettingName: SettingName.NAMES.LogSessionUserAgent,
      userUuid: '4-5-6',
      userEmail: 'test@test.te',
      unencryptedValue: LogSessionUserAgentOption.Disabled,
    })

    expect(domainEventPublisher.publish).toHaveBeenCalled()
    expect(domainEventFactory.createUserDisabledSessionUserAgentLoggingEvent).toHaveBeenCalledWith({
      userUuid: '4-5-6',
      email: 'test@test.te',
    })
  })

  it('should trigger backup if email backup setting is created - emails not muted', async () => {
    await createUseCase().execute({
      updatedSettingName: SettingName.NAMES.EmailBackupFrequency,
      userUuid: '4-5-6',
      userEmail: 'test@test.te',
      unencryptedValue: EmailBackupFrequency.Daily,
    })

    expect(triggerEmailBackupForUser.execute).toHaveBeenCalled()
  })

  it('should trigger backup if email backup setting is created - emails muted', async () => {
    await createUseCase().execute({
      updatedSettingName: SettingName.NAMES.EmailBackupFrequency,
      userUuid: '4-5-6',
      userEmail: 'test@test.te',
      unencryptedValue: EmailBackupFrequency.Daily,
    })

    expect(triggerEmailBackupForUser.execute).toHaveBeenCalled()
  })

  it('should not trigger backup if email backup setting is disabled', async () => {
    await createUseCase().execute({
      updatedSettingName: SettingName.NAMES.EmailBackupFrequency,
      userUuid: '4-5-6',
      userEmail: 'test@test.te',
      unencryptedValue: EmailBackupFrequency.Disabled,
    })

    expect(triggerEmailBackupForUser.execute).not.toHaveBeenCalled()
  })

  it('should trigger mute subscription emails rejection if mute setting changed', async () => {
    await createUseCase().execute({
      updatedSettingName: SettingName.NAMES.MuteMarketingEmails,
      userUuid: '4-5-6',
      userEmail: 'test@test.te',
      unencryptedValue: MuteMarketingEmailsOption.Muted,
    })

    expect(domainEventPublisher.publish).toHaveBeenCalled()
    expect(domainEventFactory.createMuteEmailsSettingChangedEvent).toHaveBeenCalledWith({
      emailSubscriptionRejectionLevel: 'MARKETING',
      mute: true,
      username: 'test@test.te',
    })
  })

  it('should generate new recovery codes upon enabling mfa setting', async () => {
    await createUseCase().execute({
      updatedSettingName: SettingName.NAMES.MfaSecret,
      userUuid: '4-5-6',
      userEmail: 'test@test.te',
      unencryptedValue: '123',
    })

    expect(generateRecoveryCodes.execute).toHaveBeenCalled()
  })

  it('cancels every unsent durable reminder when the user opts out', async () => {
    const first = EmailReminder.create(
      {
        userUuid: '00000000-0000-0000-0000-000000000000',
        dueAt: Date.now(),
        message: 'First',
        sent: false,
        createdAt: Date.now(),
      },
      new UniqueEntityId('reminder-1'),
    ).getValue()
    const second = EmailReminder.create(
      {
        userUuid: '00000000-0000-0000-0000-000000000000',
        dueAt: Date.now(),
        message: 'Second',
        sent: false,
        createdAt: Date.now(),
      },
      new UniqueEntityId('reminder-2'),
    ).getValue()
    emailReminderRepository.findByUserUuid = jest.fn().mockResolvedValue([first, second])
    emailReminderSender = {
      acceptanceMode: 'durable-queue',
      isConfigured: jest.fn().mockReturnValue(true),
      getDeliveryStatus: jest.fn(),
      cancelDelivery: jest.fn().mockResolvedValue('cancelled'),
      sendEmail: jest.fn(),
    }

    const result = await createUseCase().execute({
      updatedSettingName: SettingName.NAMES.EmailRemindersEnabled,
      userUuid: '00000000-0000-0000-0000-000000000000',
      userEmail: 'test@test.te',
      unencryptedValue: 'false',
    })

    expect(result.isFailed()).toBe(false)
    expect(emailReminderSender.cancelDelivery).toHaveBeenCalledTimes(2)
    expect(emailReminderSender.cancelDelivery).toHaveBeenNthCalledWith(1, createEmailReminderDeliveryId('reminder-1'))
    expect(emailReminderSender.cancelDelivery).toHaveBeenNthCalledWith(2, createEmailReminderDeliveryId('reminder-2'))
  })

  it('reports an incomplete opt-out cancellation after attempting every reminder', async () => {
    const reminders = ['reminder-1', 'reminder-2'].map((id) =>
      EmailReminder.create(
        {
          userUuid: '00000000-0000-0000-0000-000000000000',
          dueAt: Date.now(),
          message: id,
          sent: false,
          createdAt: Date.now(),
        },
        new UniqueEntityId(id),
      ).getValue(),
    )
    emailReminderRepository.findByUserUuid = jest.fn().mockResolvedValue(reminders)
    emailReminderSender = {
      acceptanceMode: 'durable-queue',
      isConfigured: jest.fn().mockReturnValue(true),
      getDeliveryStatus: jest.fn(),
      cancelDelivery: jest.fn().mockResolvedValueOnce('in-flight').mockResolvedValueOnce('cancelled'),
      sendEmail: jest.fn(),
    }

    const result = await createUseCase().execute({
      updatedSettingName: SettingName.NAMES.EmailRemindersEnabled,
      userUuid: '00000000-0000-0000-0000-000000000000',
      userEmail: 'test@test.te',
      unencryptedValue: 'false',
    })

    expect(result.isFailed()).toBe(true)
    expect(emailReminderSender.cancelDelivery).toHaveBeenCalledTimes(2)
  })
})

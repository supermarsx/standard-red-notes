import { Logger } from 'winston'
import { Result, UniqueEntityId } from '@standardnotes/domain-core'

import { EmailReminder } from '../../EmailReminder/EmailReminder'
import { EmailReminderRepositoryInterface } from '../../EmailReminder/EmailReminderRepositoryInterface'
import { EmailSenderInterface } from '../../Email/EmailSenderInterface'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'
import { GetSetting } from '../GetSetting/GetSetting'

import { TriggerDueEmailReminders } from './TriggerDueEmailReminders'

describe('TriggerDueEmailReminders', () => {
  let emailReminderRepository: EmailReminderRepositoryInterface
  let userRepository: UserRepositoryInterface
  let getSetting: GetSetting
  let emailSender: EmailSenderInterface
  let logger: Logger
  let emailRemindersEnabled: boolean
  let noRecords: boolean

  const userUuid = '00000000-0000-0000-0000-000000000000'

  const createUseCase = () =>
    new TriggerDueEmailReminders(
      emailReminderRepository,
      userRepository,
      getSetting,
      emailSender,
      logger,
      emailRemindersEnabled,
      noRecords,
    )

  const buildReminder = (id: string, message = 'Call the dentist', sent = false) =>
    EmailReminder.create(
      {
        userUuid,
        dueAt: Date.now() - 1000,
        message,
        sent,
        createdAt: Date.now(),
      },
      new UniqueEntityId(id),
    ).getValue()

  const useDurableSender = (
    status: 'pending' | 'provider-accepted' | 'dead' | 'quarantined' | 'discarded' | 'superseded' | 'missing',
    accepted = true,
  ) => {
    emailSender = {
      acceptanceMode: 'durable-queue',
      isConfigured: jest.fn().mockReturnValue(true),
      getDeliveryStatus: jest.fn().mockResolvedValue(status),
      cancelDelivery: jest.fn().mockResolvedValue('cancelled'),
      sendEmail: jest.fn().mockResolvedValue(accepted),
    }
  }

  beforeEach(() => {
    emailRemindersEnabled = true
    noRecords = false

    emailReminderRepository = {} as jest.Mocked<EmailReminderRepositoryInterface>
    emailReminderRepository.findDueUnsent = jest
      .fn()
      .mockResolvedValue([buildReminder('11111111-1111-1111-1111-111111111111')])
    emailReminderRepository.save = jest.fn().mockResolvedValue(undefined)
    emailReminderRepository.remove = jest.fn().mockResolvedValue(undefined)

    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.findOneByUuid = jest.fn().mockResolvedValue({ email: 'user@example.com' })

    getSetting = {} as jest.Mocked<GetSetting>
    getSetting.execute = jest.fn().mockResolvedValue(Result.ok({ decryptedValue: 'true' }))

    emailSender = {
      acceptanceMode: 'provider',
      isConfigured: jest.fn().mockReturnValue(true),
      sendEmail: jest.fn().mockResolvedValue(true),
    }

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
    logger.info = jest.fn()
    logger.debug = jest.fn()
  })

  it('should skip when the operator switch is off (EMAIL_REMINDERS_ENABLED)', async () => {
    emailRemindersEnabled = false

    const result = await createUseCase().execute({})

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toBe(0)
    expect(emailReminderRepository.findDueUnsent).not.toHaveBeenCalled()
    expect(emailSender.sendEmail).not.toHaveBeenCalled()
  })

  it('should skip when SMTP is not configured', async () => {
    emailSender.isConfigured = jest.fn().mockReturnValue(false)

    const result = await createUseCase().execute({})

    expect(result.getValue()).toBe(0)
    expect(emailReminderRepository.findDueUnsent).not.toHaveBeenCalled()
    expect(emailSender.sendEmail).not.toHaveBeenCalled()
  })

  it('should email a due reminder and mark it sent', async () => {
    const result = await createUseCase().execute({})

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toBe(1)
    expect(emailSender.sendEmail).toHaveBeenCalledTimes(1)

    // Subject is "Reminder: <message>".
    const subject = (emailSender.sendEmail as jest.Mock).mock.calls[0][1] as string
    expect(subject).toBe('Reminder: Call the dentist')

    // Sent to the account email.
    const to = (emailSender.sendEmail as jest.Mock).mock.calls[0][0] as string
    expect(to).toBe('user@example.com')
    expect((emailSender.sendEmail as jest.Mock).mock.calls[0][3]).toEqual({
      deliverySource: 'reminder',
      deliveryId: expect.stringMatching(/^reminder-[0-9a-f]{64}$/),
    })

    // Persisted with sent = true (records mode), not deleted.
    expect(emailReminderRepository.save).toHaveBeenCalledTimes(1)
    expect(emailReminderRepository.remove).not.toHaveBeenCalled()
    const saved = (emailReminderRepository.save as jest.Mock).mock.calls[0][0] as EmailReminder
    expect(saved.props.sent).toBe(true)
  })

  it('should NOT send when the user has not opted in', async () => {
    getSetting.execute = jest.fn().mockResolvedValue(Result.ok({ decryptedValue: 'false' }))

    const result = await createUseCase().execute({})

    expect(result.getValue()).toBe(0)
    expect(emailSender.sendEmail).not.toHaveBeenCalled()
    expect(emailReminderRepository.save).not.toHaveBeenCalled()
    expect(emailReminderRepository.remove).not.toHaveBeenCalled()
  })

  it('revokes a pending durable reminder before honoring a stale delivery receipt after opt-out', async () => {
    useDurableSender('provider-accepted')
    getSetting.execute = jest.fn().mockResolvedValue(Result.ok({ decryptedValue: 'false' }))

    const result = await createUseCase().execute({})

    expect(result.getValue()).toBe(0)
    expect(emailSender.cancelDelivery).toHaveBeenCalledWith(expect.stringMatching(/^reminder-[0-9a-f]{64}$/))
    expect(emailSender.getDeliveryStatus).not.toHaveBeenCalled()
    expect(emailSender.sendEmail).not.toHaveBeenCalled()
    expect(emailReminderRepository.save).not.toHaveBeenCalled()
    expect(emailReminderRepository.remove).not.toHaveBeenCalled()
  })

  it('should NOT send when opt-in setting is missing/failed', async () => {
    getSetting.execute = jest.fn().mockResolvedValue(Result.fail('not found'))

    const result = await createUseCase().execute({})

    expect(result.getValue()).toBe(0)
    expect(emailSender.sendEmail).not.toHaveBeenCalled()
  })

  it('should skip a reminder for an account with no deliverable email (private username)', async () => {
    // Private-username accounts store a 64-char hex with no "@".
    userRepository.findOneByUuid = jest.fn().mockResolvedValue({ email: 'a'.repeat(64) })

    const result = await createUseCase().execute({})

    expect(result.getValue()).toBe(0)
    expect(emailSender.sendEmail).not.toHaveBeenCalled()
    expect(emailReminderRepository.save).not.toHaveBeenCalled()
  })

  it('in no-records mode: delete the record on send and do not keep sent history', async () => {
    noRecords = true

    const result = await createUseCase().execute({})

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toBe(1)
    expect(emailSender.sendEmail).toHaveBeenCalledTimes(1)
    // The record is removed, never saved with sent=true.
    expect(emailReminderRepository.remove).toHaveBeenCalledTimes(1)
    expect(emailReminderRepository.save).not.toHaveBeenCalled()
  })

  it('in no-records mode: does not log recipient or message', async () => {
    noRecords = true

    await createUseCase().execute({})

    const loggedStrings = [
      ...(logger.info as jest.Mock).mock.calls,
      ...(logger.error as jest.Mock).mock.calls,
      ...(logger.debug as jest.Mock).mock.calls,
    ]
      .flat()
      .filter((value) => typeof value === 'string') as string[]

    for (const line of loggedStrings) {
      expect(line).not.toContain('user@example.com')
      expect(line).not.toContain('Call the dentist')
    }
  })

  it('keeps a no-records reminder after durable queue acceptance', async () => {
    noRecords = true
    useDurableSender('missing')

    const result = await createUseCase().execute({})

    expect(result.getValue()).toBe(0)
    expect(emailSender.sendEmail).toHaveBeenCalledTimes(1)
    expect(emailReminderRepository.remove).not.toHaveBeenCalled()
    expect(emailReminderRepository.save).not.toHaveBeenCalled()
  })

  it('deletes a no-records reminder only after provider acceptance is observed', async () => {
    noRecords = true
    useDurableSender('provider-accepted')

    const result = await createUseCase().execute({})

    expect(result.getValue()).toBe(1)
    expect(emailSender.sendEmail).not.toHaveBeenCalled()
    expect(emailReminderRepository.remove).toHaveBeenCalledTimes(1)
    expect(emailReminderRepository.save).not.toHaveBeenCalled()
  })

  it('keeps a records-mode reminder pending after durable queue acceptance', async () => {
    useDurableSender('missing')

    const result = await createUseCase().execute({})

    expect(result.getValue()).toBe(0)
    expect(emailSender.sendEmail).toHaveBeenCalledTimes(1)
    expect(emailReminderRepository.save).not.toHaveBeenCalled()
    expect(emailReminderRepository.remove).not.toHaveBeenCalled()
  })

  it('does not enqueue a duplicate while durable delivery is pending', async () => {
    useDurableSender('pending')

    const result = await createUseCase().execute({})

    expect(result.getValue()).toBe(0)
    expect(emailSender.sendEmail).not.toHaveBeenCalled()
    expect(emailReminderRepository.save).not.toHaveBeenCalled()
  })

  it.each(['dead', 'quarantined', 'discarded', 'superseded'] as const)(
    'retains and alerts for a durable reminder in terminal state %s',
    async (status) => {
      useDurableSender(status)

      const result = await createUseCase().execute({})

      expect(result.getValue()).toBe(0)
      expect(emailSender.sendEmail).not.toHaveBeenCalled()
      expect(emailReminderRepository.save).not.toHaveBeenCalled()
      expect(emailReminderRepository.remove).not.toHaveBeenCalled()
      expect(logger.error).toHaveBeenCalledWith('Durable email reminder delivery reached a terminal state.', {
        reminderId: '11111111-1111-1111-1111-111111111111',
        deliveryStatus: status,
      })
      expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('user@example.com')
      expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('Call the dentist')
    },
  )

  it('commits provider acceptance exactly once without another send', async () => {
    let storedReminder = buildReminder('11111111-1111-1111-1111-111111111111')
    emailReminderRepository.findDueUnsent = jest.fn().mockImplementation(async () => {
      return storedReminder.props.sent ? [] : [storedReminder]
    })
    emailReminderRepository.save = jest.fn().mockImplementation(async (reminder: EmailReminder) => {
      storedReminder = reminder
    })
    useDurableSender('provider-accepted')

    const first = await createUseCase().execute({})
    const second = await createUseCase().execute({})

    expect(first.getValue()).toBe(1)
    expect(second.getValue()).toBe(0)
    expect(emailSender.sendEmail).not.toHaveBeenCalled()
    expect(emailReminderRepository.save).toHaveBeenCalledTimes(1)
    expect(storedReminder.props.sent).toBe(true)
  })

  it('retains the reminder and logs only redacted metadata when status lookup fails', async () => {
    useDurableSender('missing')
    emailSender.getDeliveryStatus = jest.fn().mockRejectedValue(new Error('redis leaked detail'))

    const result = await createUseCase().execute({})

    expect(result.getValue()).toBe(0)
    expect(emailSender.sendEmail).not.toHaveBeenCalled()
    expect(emailReminderRepository.save).not.toHaveBeenCalled()
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('redis leaked detail')
    expect(logger.error).toHaveBeenCalledWith('Error processing an email reminder.', {
      reminderId: '11111111-1111-1111-1111-111111111111',
      errorType: 'Error',
      errorCode: undefined,
      status: undefined,
    })
  })

  it('should leave a reminder unsent when delivery fails (retries next scan)', async () => {
    emailSender.sendEmail = jest.fn().mockResolvedValue(false)

    const result = await createUseCase().execute({})

    expect(result.getValue()).toBe(0)
    expect(emailReminderRepository.save).not.toHaveBeenCalled()
    expect(emailReminderRepository.remove).not.toHaveBeenCalled()
  })

  it('should continue past an individual error without failing the batch', async () => {
    emailReminderRepository.findDueUnsent = jest
      .fn()
      .mockResolvedValue([
        buildReminder('11111111-1111-1111-1111-111111111111'),
        buildReminder('22222222-2222-2222-2222-222222222222', 'Second'),
      ])
    emailSender.sendEmail = jest.fn().mockRejectedValueOnce(new Error('smtp blew up')).mockResolvedValueOnce(true)

    const result = await createUseCase().execute({})

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toBe(1)
  })
})

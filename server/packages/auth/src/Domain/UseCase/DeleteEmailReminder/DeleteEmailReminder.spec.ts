import { UniqueEntityId } from '@standardnotes/domain-core'

import { EmailReminder } from '../../EmailReminder/EmailReminder'
import { EmailReminderRepositoryInterface } from '../../EmailReminder/EmailReminderRepositoryInterface'
import { createEmailReminderDeliveryId } from '../../Email/EmailDeliveryId'
import { EmailSenderInterface } from '../../Email/EmailSenderInterface'

import { DeleteEmailReminder } from './DeleteEmailReminder'

describe('DeleteEmailReminder', () => {
  let emailReminderRepository: EmailReminderRepositoryInterface
  let emailSender: EmailSenderInterface

  const userUuid = '00000000-0000-0000-0000-000000000000'
  const otherUserUuid = '11111111-1111-1111-1111-111111111111'
  const reminderId = 'reminder-1'

  const reminderOf = (owner: string, sent = false) =>
    EmailReminder.create(
      {
        userUuid: owner,
        dueAt: Date.now() + 60_000,
        message: 'Call the dentist',
        sent,
        createdAt: Date.now(),
      },
      new UniqueEntityId(reminderId),
    ).getValue()

  const createUseCase = () => new DeleteEmailReminder(emailReminderRepository, emailSender)

  beforeEach(() => {
    emailReminderRepository = {} as jest.Mocked<EmailReminderRepositoryInterface>
    emailReminderRepository.findById = jest.fn().mockResolvedValue(reminderOf(userUuid))
    emailReminderRepository.remove = jest.fn().mockResolvedValue(undefined)

    emailSender = {
      acceptanceMode: 'provider',
      isConfigured: jest.fn().mockReturnValue(true),
      sendEmail: jest.fn(),
    }
  })

  it('should fail without touching the repository if the user uuid is invalid', async () => {
    const result = await createUseCase().execute({ userUuid: 'invalid', reminderId })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toContain('Could not delete email reminder')
    expect(emailReminderRepository.findById).not.toHaveBeenCalled()
    expect(emailReminderRepository.remove).not.toHaveBeenCalled()
  })

  it('should fail if the reminder does not exist', async () => {
    emailReminderRepository.findById = jest.fn().mockResolvedValue(null)

    const result = await createUseCase().execute({ userUuid, reminderId })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('Email reminder not found')
    expect(emailReminderRepository.remove).not.toHaveBeenCalled()
  })

  it('should refuse to delete a reminder belonging to another user', async () => {
    emailReminderRepository.findById = jest.fn().mockResolvedValue(reminderOf(otherUserUuid))

    const result = await createUseCase().execute({ userUuid, reminderId })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('Email reminder not found')
    expect(emailReminderRepository.remove).not.toHaveBeenCalled()
  })

  it('should delete the reminder owned by the requesting user', async () => {
    const owned = reminderOf(userUuid)
    emailReminderRepository.findById = jest.fn().mockResolvedValue(owned)

    const result = await createUseCase().execute({ userUuid, reminderId })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toEqual('Email reminder deleted')

    const lookupId = (emailReminderRepository.findById as jest.Mock).mock.calls[0][0] as UniqueEntityId
    expect(lookupId.toString()).toEqual(reminderId)
    expect(emailReminderRepository.remove).toHaveBeenCalledWith(owned)
  })

  it('cancels a queued reminder before deleting its source row', async () => {
    const owned = reminderOf(userUuid)
    emailReminderRepository.findById = jest.fn().mockResolvedValue(owned)
    emailSender = {
      acceptanceMode: 'durable-queue',
      isConfigured: jest.fn().mockReturnValue(true),
      getDeliveryStatus: jest.fn(),
      cancelDelivery: jest.fn().mockResolvedValue('cancelled'),
      sendEmail: jest.fn(),
    }

    const result = await createUseCase().execute({ userUuid, reminderId })

    expect(result.isFailed()).toBe(false)
    expect(emailSender.cancelDelivery).toHaveBeenCalledWith(createEmailReminderDeliveryId(reminderId))
    expect((emailSender.cancelDelivery as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (emailReminderRepository.remove as jest.Mock).mock.invocationCallOrder[0],
    )
  })

  it('does not delete a reminder while its queued delivery is in flight', async () => {
    emailSender = {
      acceptanceMode: 'durable-queue',
      isConfigured: jest.fn().mockReturnValue(true),
      getDeliveryStatus: jest.fn(),
      cancelDelivery: jest.fn().mockResolvedValue('in-flight'),
      sendEmail: jest.fn(),
    }

    const result = await createUseCase().execute({ userUuid, reminderId })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toContain('already in flight')
    expect(emailReminderRepository.remove).not.toHaveBeenCalled()
  })

  it('does not create a cancellation fence for a reminder already sent', async () => {
    emailReminderRepository.findById = jest.fn().mockResolvedValue(reminderOf(userUuid, true))
    emailSender = {
      acceptanceMode: 'durable-queue',
      isConfigured: jest.fn().mockReturnValue(true),
      getDeliveryStatus: jest.fn(),
      cancelDelivery: jest.fn(),
      sendEmail: jest.fn(),
    }

    const result = await createUseCase().execute({ userUuid, reminderId })

    expect(result.isFailed()).toBe(false)
    expect(emailSender.cancelDelivery).not.toHaveBeenCalled()
    expect(emailReminderRepository.remove).toHaveBeenCalledTimes(1)
  })
})

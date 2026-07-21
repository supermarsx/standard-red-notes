import { UniqueEntityId } from '@standardnotes/domain-core'

import { EmailReminder } from '../../EmailReminder/EmailReminder'
import { EmailReminderRepositoryInterface } from '../../EmailReminder/EmailReminderRepositoryInterface'

import { DeleteEmailReminder } from './DeleteEmailReminder'

describe('DeleteEmailReminder', () => {
  let emailReminderRepository: EmailReminderRepositoryInterface

  const userUuid = '00000000-0000-0000-0000-000000000000'
  const otherUserUuid = '11111111-1111-1111-1111-111111111111'
  const reminderId = 'reminder-1'

  const reminderOf = (owner: string) => ({ props: { userUuid: owner } }) as jest.Mocked<EmailReminder>

  const createUseCase = () => new DeleteEmailReminder(emailReminderRepository)

  beforeEach(() => {
    emailReminderRepository = {} as jest.Mocked<EmailReminderRepositoryInterface>
    emailReminderRepository.findById = jest.fn().mockResolvedValue(reminderOf(userUuid))
    emailReminderRepository.remove = jest.fn().mockResolvedValue(undefined)
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
})

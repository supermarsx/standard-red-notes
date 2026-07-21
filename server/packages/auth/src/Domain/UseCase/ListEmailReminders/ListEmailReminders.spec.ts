import { Uuid } from '@standardnotes/domain-core'

import { EmailReminder } from '../../EmailReminder/EmailReminder'
import { EmailReminderRepositoryInterface } from '../../EmailReminder/EmailReminderRepositoryInterface'

import { ListEmailReminders } from './ListEmailReminders'

describe('ListEmailReminders', () => {
  let emailReminderRepository: EmailReminderRepositoryInterface

  const userUuid = '00000000-0000-0000-0000-000000000000'
  const reminders = [{ props: { subject: 'Standup' } }] as jest.Mocked<EmailReminder[]>

  const createUseCase = () => new ListEmailReminders(emailReminderRepository)

  beforeEach(() => {
    emailReminderRepository = {} as jest.Mocked<EmailReminderRepositoryInterface>
    emailReminderRepository.findByUserUuid = jest.fn().mockResolvedValue(reminders)
  })

  it('should fail without querying the repository if the user uuid is invalid', async () => {
    const result = await createUseCase().execute({ userUuid: 'invalid' })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toContain('Could not list email reminders')
    expect(emailReminderRepository.findByUserUuid).not.toHaveBeenCalled()
  })

  it('should return the reminders scoped to the requesting user', async () => {
    const result = await createUseCase().execute({ userUuid })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toEqual(reminders)

    expect(emailReminderRepository.findByUserUuid).toHaveBeenCalledTimes(1)
    const queriedUuid = (emailReminderRepository.findByUserUuid as jest.Mock).mock.calls[0][0] as Uuid
    expect(queriedUuid.value).toEqual(userUuid)
  })
})

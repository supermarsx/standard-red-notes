import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { EmailReminder } from '../../EmailReminder/EmailReminder'
import { EmailReminderRepositoryInterface } from '../../EmailReminder/EmailReminderRepositoryInterface'

import { ListEmailRemindersDTO } from './ListEmailRemindersDTO'

export class ListEmailReminders implements UseCaseInterface<EmailReminder[]> {
  constructor(private emailReminderRepository: EmailReminderRepositoryInterface) {}

  async execute(dto: ListEmailRemindersDTO): Promise<Result<EmailReminder[]>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(`Could not list email reminders: ${userUuidOrError.getError()}`)
    }
    const userUuid = userUuidOrError.getValue()

    // Repository scopes by user uuid, so other users' reminders never leak.
    const reminders = await this.emailReminderRepository.findByUserUuid(userUuid)

    return Result.ok(reminders)
  }
}

import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { EmailReminder } from '../../EmailReminder/EmailReminder'
import { EmailReminderRepositoryInterface } from '../../EmailReminder/EmailReminderRepositoryInterface'

import { CreateEmailReminderDTO } from './CreateEmailReminderDTO'
import { CreateEmailReminderResult } from './CreateEmailReminderResult'

const MAX_MESSAGE_LENGTH = 500

export class CreateEmailReminder implements UseCaseInterface<CreateEmailReminderResult> {
  constructor(private emailReminderRepository: EmailReminderRepositoryInterface) {}

  async execute(dto: CreateEmailReminderDTO): Promise<Result<CreateEmailReminderResult>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(`Could not create email reminder: ${userUuidOrError.getError()}`)
    }
    const userUuid = userUuidOrError.getValue()

    const dueAt = this.normaliseDueAt(dto.dueAt)
    if (dueAt === null) {
      return Result.fail('Could not create email reminder: due time is invalid.')
    }

    if (typeof dto.message !== 'string' || dto.message.trim().length === 0) {
      return Result.fail('Could not create email reminder: message is required.')
    }
    const message = dto.message.trim().slice(0, MAX_MESSAGE_LENGTH)

    const now = Date.now()

    const reminderOrError = EmailReminder.create({
      userUuid: userUuid.value,
      dueAt,
      message,
      sent: false,
      createdAt: now,
    })
    if (reminderOrError.isFailed()) {
      return Result.fail(`Could not create email reminder: ${reminderOrError.getError()}`)
    }
    const emailReminder = reminderOrError.getValue()

    await this.emailReminderRepository.save(emailReminder)

    return Result.ok({
      uuid: emailReminder.id.toString(),
      dueAt,
      message,
      sent: false,
      createdAt: now,
    })
  }

  private normaliseDueAt(value: number | string): number | null {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null
    }
    if (typeof value === 'string') {
      const parsed = Date.parse(value)
      return Number.isNaN(parsed) ? null : parsed
    }
    return null
  }
}

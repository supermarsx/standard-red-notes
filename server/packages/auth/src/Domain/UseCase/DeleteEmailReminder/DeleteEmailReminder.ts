import { Result, UniqueEntityId, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { EmailReminderRepositoryInterface } from '../../EmailReminder/EmailReminderRepositoryInterface'
import { cancelDurableEmailDelivery } from '../../Email/DurableEmailCancellation'
import { createEmailReminderDeliveryId } from '../../Email/EmailDeliveryId'
import { EmailSenderInterface } from '../../Email/EmailSenderInterface'

import { DeleteEmailReminderDTO } from './DeleteEmailReminderDTO'

export class DeleteEmailReminder implements UseCaseInterface<string> {
  constructor(
    private emailReminderRepository: EmailReminderRepositoryInterface,
    private emailSender: EmailSenderInterface,
  ) {}

  async execute(dto: DeleteEmailReminderDTO): Promise<Result<string>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(`Could not delete email reminder: ${userUuidOrError.getError()}`)
    }
    const userUuid = userUuidOrError.getValue()

    const emailReminder = await this.emailReminderRepository.findById(new UniqueEntityId(dto.reminderId))
    // Ownership check: never allow deleting another user's reminder.
    if (!emailReminder || emailReminder.props.userUuid !== userUuid.value) {
      return Result.fail('Email reminder not found')
    }

    if (!emailReminder.props.sent) {
      try {
        const cancellation = await cancelDurableEmailDelivery(
          this.emailSender,
          createEmailReminderDeliveryId(emailReminder.id.toString()),
        )
        if (cancellation === 'in-flight') {
          return Result.fail('Could not delete email reminder: the email delivery is already in flight.')
        }
      } catch {
        return Result.fail('Could not delete email reminder: durable email delivery cancellation is unavailable.')
      }
    }

    await this.emailReminderRepository.remove(emailReminder)

    return Result.ok('Email reminder deleted')
  }
}

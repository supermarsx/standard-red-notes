import { Entity, Result, UniqueEntityId } from '@standardnotes/domain-core'

import { EmailReminderProps } from './EmailReminderProps'

export class EmailReminder extends Entity<EmailReminderProps> {
  private constructor(props: EmailReminderProps, id?: UniqueEntityId) {
    super(props, id)
  }

  static create(props: EmailReminderProps, id?: UniqueEntityId): Result<EmailReminder> {
    if (props.message.length === 0) {
      return Result.fail<EmailReminder>('Email reminder message cannot be empty')
    }

    if (!Number.isFinite(props.dueAt)) {
      return Result.fail<EmailReminder>('Email reminder due time must be a valid timestamp')
    }

    return Result.ok<EmailReminder>(new EmailReminder(props, id))
  }
}

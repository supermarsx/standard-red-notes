import { MapperInterface } from '@standardnotes/domain-core'

import { EmailReminder } from '../Domain/EmailReminder/EmailReminder'
import { EmailReminderHttpProjection } from '../Infra/Http/Projection/EmailReminderHttpProjection'

export class EmailReminderHttpMapper implements MapperInterface<EmailReminder, EmailReminderHttpProjection> {
  toDomain(_projection: EmailReminderHttpProjection): EmailReminder {
    throw new Error('Not implemented yet.')
  }

  toProjection(domain: EmailReminder): EmailReminderHttpProjection {
    return {
      uuid: domain.id.toString(),
      dueAt: domain.props.dueAt,
      message: domain.props.message,
      sent: domain.props.sent,
      createdAt: domain.props.createdAt,
    }
  }
}

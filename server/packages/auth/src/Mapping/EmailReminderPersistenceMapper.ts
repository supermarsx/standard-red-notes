import { MapperInterface, UniqueEntityId } from '@standardnotes/domain-core'

import { EmailReminder } from '../Domain/EmailReminder/EmailReminder'
import { TypeORMEmailReminder } from '../Infra/TypeORM/TypeORMEmailReminder'

export class EmailReminderPersistenceMapper implements MapperInterface<EmailReminder, TypeORMEmailReminder> {
  toDomain(projection: TypeORMEmailReminder): EmailReminder {
    const reminderOrError = EmailReminder.create(
      {
        userUuid: projection.userUuid,
        dueAt: Number(projection.dueAt),
        message: projection.message,
        sent: Boolean(projection.sent),
        createdAt: Number(projection.createdAt),
      },
      new UniqueEntityId(projection.uuid),
    )
    if (reminderOrError.isFailed()) {
      throw new Error(`Failed to create email reminder from projection: ${reminderOrError.getError()}`)
    }

    return reminderOrError.getValue()
  }

  toProjection(domain: EmailReminder): TypeORMEmailReminder {
    const typeorm = new TypeORMEmailReminder()

    typeorm.uuid = domain.id.toString()
    typeorm.userUuid = domain.props.userUuid
    typeorm.dueAt = domain.props.dueAt
    typeorm.message = domain.props.message
    typeorm.sent = domain.props.sent
    typeorm.createdAt = domain.props.createdAt

    return typeorm
  }
}

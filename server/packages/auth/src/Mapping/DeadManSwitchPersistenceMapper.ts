import { MapperInterface, UniqueEntityId } from '@standardnotes/domain-core'

import { DeadManSwitch } from '../Domain/DeadManSwitch/DeadManSwitch'
import { TypeORMDeadManSwitch } from '../Infra/TypeORM/TypeORMDeadManSwitch'

export class DeadManSwitchPersistenceMapper implements MapperInterface<DeadManSwitch, TypeORMDeadManSwitch> {
  toDomain(projection: TypeORMDeadManSwitch): DeadManSwitch {
    const switchOrError = DeadManSwitch.create(
      {
        userUuid: projection.userUuid,
        recipientEmail: projection.recipientEmail,
        shareUrl: projection.shareUrl,
        message: projection.message ?? null,
        intervalDays: Number(projection.intervalDays),
        deadline: Number(projection.deadline),
        triggered: Boolean(projection.triggered),
        lastCheckInAt: projection.lastCheckInAt === null ? null : Number(projection.lastCheckInAt),
        createdAt: Number(projection.createdAt),
        sendAttempts: projection.sendAttempts === null ? 0 : Number(projection.sendAttempts),
        nextAttemptAt: projection.nextAttemptAt === null ? null : Number(projection.nextAttemptAt),
        lastAttemptAt: projection.lastAttemptAt === null ? null : Number(projection.lastAttemptAt),
        lastError: projection.lastError ?? null,
      },
      new UniqueEntityId(projection.uuid),
    )
    if (switchOrError.isFailed()) {
      throw new Error(`Failed to create dead man switch from projection: ${switchOrError.getError()}`)
    }

    return switchOrError.getValue()
  }

  toProjection(domain: DeadManSwitch): TypeORMDeadManSwitch {
    const typeorm = new TypeORMDeadManSwitch()

    typeorm.uuid = domain.id.toString()
    typeorm.userUuid = domain.props.userUuid
    typeorm.recipientEmail = domain.props.recipientEmail
    typeorm.shareUrl = domain.props.shareUrl
    typeorm.message = domain.props.message
    typeorm.intervalDays = domain.props.intervalDays
    typeorm.deadline = domain.props.deadline
    typeorm.triggered = domain.props.triggered
    typeorm.lastCheckInAt = domain.props.lastCheckInAt
    typeorm.createdAt = domain.props.createdAt
    typeorm.sendAttempts = domain.props.sendAttempts
    typeorm.nextAttemptAt = domain.props.nextAttemptAt
    typeorm.lastAttemptAt = domain.props.lastAttemptAt
    typeorm.lastError = domain.props.lastError

    return typeorm
  }
}

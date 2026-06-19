import { MapperInterface, UniqueEntityId } from '@standardnotes/domain-core'

import { AppPassword } from '../Domain/AppPassword/AppPassword'
import { TypeORMAppPassword } from '../Infra/TypeORM/TypeORMAppPassword'

export class AppPasswordPersistenceMapper implements MapperInterface<AppPassword, TypeORMAppPassword> {
  toDomain(projection: TypeORMAppPassword): AppPassword {
    const appPasswordOrError = AppPassword.create(
      {
        userUuid: projection.userUuid,
        label: projection.label,
        hashedPassword: projection.hashedPassword,
        createdAt: projection.createdAt,
        lastUsedAt: projection.lastUsedAt,
      },
      new UniqueEntityId(projection.uuid),
    )
    if (appPasswordOrError.isFailed()) {
      throw new Error(`Failed to create app password from projection: ${appPasswordOrError.getError()}`)
    }

    return appPasswordOrError.getValue()
  }

  toProjection(domain: AppPassword): TypeORMAppPassword {
    const typeorm = new TypeORMAppPassword()

    typeorm.uuid = domain.id.toString()
    typeorm.userUuid = domain.props.userUuid
    typeorm.label = domain.props.label
    typeorm.hashedPassword = domain.props.hashedPassword
    typeorm.createdAt = domain.props.createdAt
    typeorm.lastUsedAt = domain.props.lastUsedAt

    return typeorm
  }
}

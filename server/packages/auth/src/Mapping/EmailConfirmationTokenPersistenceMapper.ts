import { MapperInterface, UniqueEntityId } from '@standardnotes/domain-core'

import { EmailConfirmationToken } from '../Domain/EmailConfirmation/EmailConfirmationToken'
import { TypeORMEmailConfirmationToken } from '../Infra/TypeORM/TypeORMEmailConfirmationToken'

export class EmailConfirmationTokenPersistenceMapper implements MapperInterface<
  EmailConfirmationToken,
  TypeORMEmailConfirmationToken
> {
  toDomain(projection: TypeORMEmailConfirmationToken): EmailConfirmationToken {
    const tokenOrError = EmailConfirmationToken.create(
      {
        userUuid: projection.userUuid,
        email: projection.email,
        hashedToken: projection.hashedToken,
        expiresAt: projection.expiresAt,
        consumed: projection.consumed,
        createdAt: projection.createdAt,
      },
      new UniqueEntityId(projection.uuid),
    )
    if (tokenOrError.isFailed()) {
      throw new Error(`Failed to create email confirmation token from projection: ${tokenOrError.getError()}`)
    }

    return tokenOrError.getValue()
  }

  toProjection(domain: EmailConfirmationToken): TypeORMEmailConfirmationToken {
    const typeorm = new TypeORMEmailConfirmationToken()

    typeorm.uuid = domain.id.toString()
    typeorm.userUuid = domain.props.userUuid
    typeorm.email = domain.props.email
    typeorm.hashedToken = domain.props.hashedToken
    typeorm.expiresAt = domain.props.expiresAt
    typeorm.consumed = domain.props.consumed
    typeorm.createdAt = domain.props.createdAt

    return typeorm
  }
}

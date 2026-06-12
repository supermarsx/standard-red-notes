import { MapperInterface, UniqueEntityId } from '@standardnotes/domain-core'

import { MagicLinkToken } from '../Domain/MagicLink/MagicLinkToken'
import { TypeORMMagicLinkToken } from '../Infra/TypeORM/TypeORMMagicLinkToken'

export class MagicLinkTokenPersistenceMapper implements MapperInterface<MagicLinkToken, TypeORMMagicLinkToken> {
  toDomain(projection: TypeORMMagicLinkToken): MagicLinkToken {
    const magicLinkTokenOrError = MagicLinkToken.create(
      {
        userIdentifier: projection.userIdentifier,
        code: projection.code,
        expiresAt: projection.expiresAt,
        consumed: projection.consumed,
        createdAt: projection.createdAt,
      },
      new UniqueEntityId(projection.uuid),
    )
    if (magicLinkTokenOrError.isFailed()) {
      throw new Error(`Failed to create magic link token from projection: ${magicLinkTokenOrError.getError()}`)
    }

    return magicLinkTokenOrError.getValue()
  }

  toProjection(domain: MagicLinkToken): TypeORMMagicLinkToken {
    const typeorm = new TypeORMMagicLinkToken()

    typeorm.uuid = domain.id.toString()
    typeorm.userIdentifier = domain.props.userIdentifier
    typeorm.code = domain.props.code
    typeorm.expiresAt = domain.props.expiresAt
    typeorm.consumed = domain.props.consumed
    typeorm.createdAt = domain.props.createdAt

    return typeorm
  }
}

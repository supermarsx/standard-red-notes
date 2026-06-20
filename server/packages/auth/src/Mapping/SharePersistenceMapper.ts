import { MapperInterface, UniqueEntityId } from '@standardnotes/domain-core'

import { Share } from '../Domain/Share/Share'
import { TypeORMShare } from '../Infra/TypeORM/TypeORMShare'

export class SharePersistenceMapper implements MapperInterface<Share, TypeORMShare> {
  toDomain(projection: TypeORMShare): Share {
    const type = projection.type === 'tag' ? 'tag' : projection.type === 'account' ? 'account' : 'note'

    const shareOrError = Share.create(
      {
        userUuid: projection.userUuid,
        type,
        encryptedPayload: projection.encryptedPayload,
        nickname: projection.nickname ?? null,
        createdAt: new Date(Number(projection.createdAt)),
        revoked: Boolean(projection.revoked),
      },
      new UniqueEntityId(projection.uuid),
    )
    if (shareOrError.isFailed()) {
      throw new Error(`Failed to create share from projection: ${shareOrError.getError()}`)
    }

    return shareOrError.getValue()
  }

  toProjection(domain: Share): TypeORMShare {
    const typeorm = new TypeORMShare()

    typeorm.uuid = domain.id.toString()
    typeorm.userUuid = domain.props.userUuid
    typeorm.type = domain.props.type
    typeorm.encryptedPayload = domain.props.encryptedPayload
    typeorm.nickname = domain.props.nickname
    typeorm.createdAt = domain.props.createdAt.getTime()
    typeorm.revoked = domain.props.revoked

    return typeorm
  }
}

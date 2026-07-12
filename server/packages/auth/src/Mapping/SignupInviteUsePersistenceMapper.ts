import { MapperInterface, UniqueEntityId } from '@standardnotes/domain-core'

import { SignupInviteUse } from '../Domain/SignupInvite/SignupInviteUse'
import { TypeORMSignupInviteUse } from '../Infra/TypeORM/TypeORMSignupInviteUse'

export class SignupInviteUsePersistenceMapper implements MapperInterface<SignupInviteUse, TypeORMSignupInviteUse> {
  toDomain(projection: TypeORMSignupInviteUse): SignupInviteUse {
    const useOrError = SignupInviteUse.create(
      {
        inviteLinkUuid: projection.inviteLinkUuid,
        newUserUuid: projection.newUserUuid,
        referrerUserUuid: projection.referrerUserUuid ?? null,
        createdAt: new Date(projection.createdAt),
      },
      new UniqueEntityId(projection.uuid),
    )
    if (useOrError.isFailed()) {
      throw new Error(`Failed to create signup invite use from projection: ${useOrError.getError()}`)
    }

    return useOrError.getValue()
  }

  toProjection(domain: SignupInviteUse): TypeORMSignupInviteUse {
    const typeorm = new TypeORMSignupInviteUse()

    typeorm.uuid = domain.id.toString()
    typeorm.inviteLinkUuid = domain.props.inviteLinkUuid
    typeorm.newUserUuid = domain.props.newUserUuid
    typeorm.referrerUserUuid = domain.props.referrerUserUuid
    typeorm.createdAt = domain.props.createdAt

    return typeorm
  }
}

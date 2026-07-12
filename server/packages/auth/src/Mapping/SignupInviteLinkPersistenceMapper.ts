import { MapperInterface, UniqueEntityId } from '@standardnotes/domain-core'

import { SignupInviteLink } from '../Domain/SignupInvite/SignupInviteLink'
import { SignupInviteLinkCreatorKind } from '../Domain/SignupInvite/SignupInviteLinkProps'
import { TypeORMSignupInviteLink } from '../Infra/TypeORM/TypeORMSignupInviteLink'

export class SignupInviteLinkPersistenceMapper
  implements MapperInterface<SignupInviteLink, TypeORMSignupInviteLink>
{
  toDomain(projection: TypeORMSignupInviteLink): SignupInviteLink {
    const linkOrError = SignupInviteLink.create(
      {
        hashedToken: projection.hashedToken,
        label: projection.label ?? null,
        maxUses: Number(projection.maxUses),
        usedCount: Number(projection.usedCount),
        expiresAt: projection.expiresAt ? new Date(projection.expiresAt) : null,
        // tinyint(1): MySQL hydrates 0/1, a freshly built entity carries a boolean.
        revoked: Number(projection.revoked) === 1,
        defaultRole: projection.defaultRole ?? null,
        allowedDomain: projection.allowedDomain ?? null,
        createdBy: projection.createdBy ?? null,
        createdByUserUuid: projection.createdByUserUuid ?? null,
        createdByKind: (projection.createdByKind === 'user' ? 'user' : 'admin') as SignupInviteLinkCreatorKind,
        autoApprove: Number(projection.autoApprove) === 1,
        createdAt: new Date(projection.createdAt),
        updatedAt: new Date(projection.updatedAt),
      },
      new UniqueEntityId(projection.uuid),
    )
    if (linkOrError.isFailed()) {
      throw new Error(`Failed to create signup invite link from projection: ${linkOrError.getError()}`)
    }

    return linkOrError.getValue()
  }

  toProjection(domain: SignupInviteLink): TypeORMSignupInviteLink {
    const typeorm = new TypeORMSignupInviteLink()

    typeorm.uuid = domain.id.toString()
    typeorm.hashedToken = domain.props.hashedToken
    typeorm.label = domain.props.label
    typeorm.maxUses = domain.props.maxUses
    typeorm.usedCount = domain.props.usedCount
    typeorm.expiresAt = domain.props.expiresAt
    typeorm.revoked = domain.props.revoked
    typeorm.defaultRole = domain.props.defaultRole
    typeorm.allowedDomain = domain.props.allowedDomain
    typeorm.createdBy = domain.props.createdBy
    typeorm.createdByUserUuid = domain.props.createdByUserUuid
    typeorm.createdByKind = domain.props.createdByKind
    typeorm.autoApprove = domain.props.autoApprove
    typeorm.createdAt = domain.props.createdAt
    typeorm.updatedAt = domain.props.updatedAt

    return typeorm
  }
}

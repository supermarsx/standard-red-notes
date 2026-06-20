import { MapperInterface, UniqueEntityId } from '@standardnotes/domain-core'

import { PendingMfaApproval } from '../Domain/PendingMfaApproval/PendingMfaApproval'
import { PendingMfaApprovalStatus } from '../Domain/PendingMfaApproval/PendingMfaApprovalProps'
import { TypeORMPendingMfaApproval } from '../Infra/TypeORM/TypeORMPendingMfaApproval'

export class PendingMfaApprovalPersistenceMapper
  implements MapperInterface<PendingMfaApproval, TypeORMPendingMfaApproval>
{
  toDomain(projection: TypeORMPendingMfaApproval): PendingMfaApproval {
    const approvalOrError = PendingMfaApproval.create(
      {
        userUuid: projection.userUuid,
        challengeId: projection.challengeId,
        status: projection.status as PendingMfaApprovalStatus,
        requestingUserAgent: projection.requestingUserAgent ?? '',
        requestingIpAddress: projection.requestingIpAddress ?? null,
        createdAt: Number(projection.createdAt),
        expiresAt: Number(projection.expiresAt),
        consumed: Boolean(projection.consumed),
      },
      new UniqueEntityId(projection.uuid),
    )
    if (approvalOrError.isFailed()) {
      throw new Error(`Failed to create pending MFA approval from projection: ${approvalOrError.getError()}`)
    }

    return approvalOrError.getValue()
  }

  toProjection(domain: PendingMfaApproval): TypeORMPendingMfaApproval {
    const typeorm = new TypeORMPendingMfaApproval()

    typeorm.uuid = domain.id.toString()
    typeorm.userUuid = domain.props.userUuid
    typeorm.challengeId = domain.props.challengeId
    typeorm.status = domain.props.status
    typeorm.requestingUserAgent = domain.props.requestingUserAgent
    typeorm.requestingIpAddress = domain.props.requestingIpAddress
    typeorm.createdAt = domain.props.createdAt
    typeorm.expiresAt = domain.props.expiresAt
    typeorm.consumed = domain.props.consumed

    return typeorm
  }
}

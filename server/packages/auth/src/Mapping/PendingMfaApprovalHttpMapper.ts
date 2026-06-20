import { MapperInterface } from '@standardnotes/domain-core'

import { PendingMfaApproval } from '../Domain/PendingMfaApproval/PendingMfaApproval'
import { PendingMfaApprovalHttpProjection } from '../Infra/Http/Projection/PendingMfaApprovalHttpProjection'

export class PendingMfaApprovalHttpMapper
  implements MapperInterface<PendingMfaApproval, PendingMfaApprovalHttpProjection>
{
  toDomain(_projection: PendingMfaApprovalHttpProjection): PendingMfaApproval {
    throw new Error('Not implemented yet.')
  }

  toProjection(domain: PendingMfaApproval): PendingMfaApprovalHttpProjection {
    // Shown to the approving (trusted) session. Includes the device + time + IP
    // context required for the user to make a safe approve/deny decision.
    return {
      uuid: domain.id.toString(),
      challengeId: domain.props.challengeId,
      status: domain.props.status,
      requestingUserAgent: domain.props.requestingUserAgent,
      requestingIpAddress: domain.props.requestingIpAddress,
      createdAt: domain.props.createdAt,
      expiresAt: domain.props.expiresAt,
    }
  }
}

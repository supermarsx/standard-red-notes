import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { PendingMfaApproval } from '../../PendingMfaApproval/PendingMfaApproval'
import { PendingMfaApprovalRepositoryInterface } from '../../PendingMfaApproval/PendingMfaApprovalRepositoryInterface'

import { ListPendingMfaApprovalsDTO } from './ListPendingMfaApprovalsDTO'

/**
 * Lists the actionable (pending, non-expired) approvals for the authenticated
 * user's account. Used by a trusted session that connects/reconnects and wants
 * to catch up on any approval requests it may have missed over the websocket.
 */
export class ListPendingMfaApprovals implements UseCaseInterface<PendingMfaApproval[]> {
  constructor(private pendingMfaApprovalRepository: PendingMfaApprovalRepositoryInterface) {}

  async execute(dto: ListPendingMfaApprovalsDTO): Promise<Result<PendingMfaApproval[]>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(`Could not list pending MFA approvals: ${userUuidOrError.getError()}`)
    }
    const userUuid = userUuidOrError.getValue()

    const now = Date.now()
    const approvals = await this.pendingMfaApprovalRepository.findPendingByUserUuid(userUuid)

    return Result.ok(approvals.filter((approval) => approval.isActionable(now)))
  }
}

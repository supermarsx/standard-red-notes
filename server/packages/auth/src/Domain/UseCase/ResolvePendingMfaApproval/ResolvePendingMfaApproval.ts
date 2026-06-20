import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { PendingMfaApprovalRepositoryInterface } from '../../PendingMfaApproval/PendingMfaApprovalRepositoryInterface'

import { ResolvePendingMfaApprovalDTO } from './ResolvePendingMfaApprovalDTO'

/**
 * Approve or deny a pending MFA approval from an already-authenticated (trusted)
 * session.
 *
 * SECURITY:
 *  - The caller must be authenticated and the approval must belong to the SAME
 *    account (ownership check).
 *  - Only an actionable approval (pending, not consumed, not expired) can be
 *    resolved — this enforces single-use and TTL.
 *  - Denying sets status to `denied`, which permanently blocks the new device's
 *    login for this challenge.
 */
export class ResolvePendingMfaApproval implements UseCaseInterface<string> {
  constructor(private pendingMfaApprovalRepository: PendingMfaApprovalRepositoryInterface) {}

  async execute(dto: ResolvePendingMfaApprovalDTO): Promise<Result<string>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(`Could not resolve MFA approval: ${userUuidOrError.getError()}`)
    }
    const userUuid = userUuidOrError.getValue()

    const approval = await this.pendingMfaApprovalRepository.findByChallengeId(dto.challengeId)
    // Ownership check: never let a session resolve another account's approval.
    if (!approval || approval.props.userUuid !== userUuid.value) {
      return Result.fail('Pending MFA approval not found')
    }

    if (!approval.isActionable(Date.now())) {
      return Result.fail('Pending MFA approval is no longer actionable')
    }

    approval.props.status = dto.approve ? 'approved' : 'denied'
    await this.pendingMfaApprovalRepository.save(approval)

    return Result.ok(dto.approve ? 'approved' : 'denied')
  }
}

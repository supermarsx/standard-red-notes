import { Result, UseCaseInterface } from '@standardnotes/domain-core'

import { PendingMfaApprovalRepositoryInterface } from '../../PendingMfaApproval/PendingMfaApprovalRepositoryInterface'

import { GetPendingMfaApprovalStatusDTO } from './GetPendingMfaApprovalStatusDTO'
import { GetPendingMfaApprovalStatusResult } from './GetPendingMfaApprovalStatusResult'

/**
 * Polled by the NEW (untrusted) device using the high-entropy challenge id it
 * received when the approval was created. The challenge id is the only
 * credential here (the device is not yet signed in), so it must be unguessable
 * (256-bit) and single-use.
 *
 * SECURITY:
 *  - An expired or missing approval reports 'expired' — the device must fall
 *    back to interactive TOTP.
 *  - 'approved' is reported AT MOST ONCE: the row is marked consumed so a replay
 *    (e.g. a captured challenge id used twice) reports 'expired' thereafter.
 *    Single-use is what lets the client safely treat 'approved' as a one-shot
 *    "second factor satisfied" signal for this sign-in only.
 *  - 'denied' is terminal and blocks the login.
 *
 * NOTE: Reporting 'approved' here only tells the client the second factor was
 * satisfied; the client must still complete the normal password sign-in. The
 * server-side enforcement that ties this to the 2FA gate is documented as
 * remaining work (see report) — this use case provides the status the client
 * polls, and the gate-bypass token issuance is the piece to wire next.
 */
export class GetPendingMfaApprovalStatus implements UseCaseInterface<GetPendingMfaApprovalStatusResult> {
  constructor(private pendingMfaApprovalRepository: PendingMfaApprovalRepositoryInterface) {}

  async execute(dto: GetPendingMfaApprovalStatusDTO): Promise<Result<GetPendingMfaApprovalStatusResult>> {
    if (typeof dto.challengeId !== 'string' || dto.challengeId.length === 0) {
      return Result.ok({ status: 'expired' })
    }

    const approval = await this.pendingMfaApprovalRepository.findByChallengeId(dto.challengeId)
    if (!approval) {
      return Result.ok({ status: 'expired' })
    }

    const now = Date.now()

    if (approval.props.consumed || approval.isExpired(now)) {
      return Result.ok({ status: 'expired' })
    }

    if (approval.props.status === 'denied') {
      return Result.ok({ status: 'denied' })
    }

    if (approval.props.status === 'approved') {
      // Single-use: consume on first read so a replay cannot reuse it.
      approval.props.consumed = true
      await this.pendingMfaApprovalRepository.save(approval)

      return Result.ok({ status: 'approved' })
    }

    return Result.ok({ status: 'pending' })
  }
}

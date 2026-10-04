import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'
import { DomainEventPublisherInterface } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { PendingMfaApprovalRepositoryInterface } from '../../PendingMfaApproval/PendingMfaApprovalRepositoryInterface'
import { DomainEventFactoryInterface } from '../../Event/DomainEventFactoryInterface'
import { safeErrorLogMetadata } from '../../Logging/SafeLog'

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
 *
 * REALTIME (Standard Red Notes): the DECISION is announced to the account's other
 * open sessions as an `MFA_APPROVAL_RESOLVED` frame, the mirror of the
 * `MFA_APPROVAL_REQUESTED` frame `CreatePendingMfaApproval` publishes. Without it
 * the only way a second trusted session could learn that a request it is still
 * showing had been answered elsewhere was to re-GET the inbox, which is why that
 * inbox polled every 6 s even with a healthy socket.
 *
 * It is a NOTIFICATION, not an action: this use case is still reached only over
 * authenticated HTTP (`POST /v1/pending-mfa-approvals/:challengeId/resolve`), and
 * the push is best-effort — a failed publish must never fail a resolution that is
 * already durably saved, so the clients keep their safety-net poll.
 */
export class ResolvePendingMfaApproval implements UseCaseInterface<string> {
  constructor(
    private pendingMfaApprovalRepository: PendingMfaApprovalRepositoryInterface,
    private domainEventPublisher: DomainEventPublisherInterface,
    private domainEventFactory: DomainEventFactoryInterface,
    private logger: Logger,
  ) {}

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

    const status = dto.approve ? 'approved' : 'denied'
    approval.props.status = status
    await this.pendingMfaApprovalRepository.save(approval)

    // Published AFTER the save, so a frame can never announce a decision that was
    // not persisted. The frame carries no credential the recipient does not already
    // hold: the challenge id is the same one the request frame already delivered to
    // these very sockets, and it is addressed to this account only.
    try {
      await this.domainEventPublisher.publish(
        this.domainEventFactory.createWebSocketMessageRequestedEvent({
          userUuid: userUuid.value,
          message: JSON.stringify({
            type: 'MFA_APPROVAL_RESOLVED',
            challengeId: dto.challengeId,
            status,
            resolvedAt: Date.now(),
          }),
        }),
      )
    } catch (error) {
      this.logger.error('Could not push the MFA approval-resolved frame.', safeErrorLogMetadata(error))
    }

    return Result.ok(status)
  }
}

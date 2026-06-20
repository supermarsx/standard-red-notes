import * as crypto from 'crypto'
import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'
import { DomainEventPublisherInterface } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { PendingMfaApproval } from '../../PendingMfaApproval/PendingMfaApproval'
import { PendingMfaApprovalRepositoryInterface } from '../../PendingMfaApproval/PendingMfaApprovalRepositoryInterface'
import { DomainEventFactoryInterface } from '../../Event/DomainEventFactoryInterface'

import { CreatePendingMfaApprovalDTO } from './CreatePendingMfaApprovalDTO'
import { CreatePendingMfaApprovalResult } from './CreatePendingMfaApprovalResult'

/**
 * Standard Red Notes: push-MFA approval. When an UNTRUSTED device hits the 2FA
 * challenge, this use case records a short-lived pending approval and pushes an
 * "approval requested" frame to the user's OTHER open, authenticated sessions
 * over the existing websocket gateway (via WebSocketMessageRequestedEvent — the
 * same channel used for role-change frames). An already-trusted session can then
 * approve or deny it.
 *
 * SECURITY:
 *  - The approval starts as `pending`; the new device only completes auth once
 *    a trusted session flips it to `approved` (see ResolvePendingMfaApproval).
 *  - Short TTL (default 2 minutes) and single-use consumption.
 *  - The frame carries device/user-agent + IP + timestamp so the approver has
 *    enough context to judge — never a contextless "tap yes".
 *  - This is an ADDITIONAL path; the interactive TOTP input is never removed.
 */
export class CreatePendingMfaApproval implements UseCaseInterface<CreatePendingMfaApprovalResult> {
  private readonly CHALLENGE_ID_BYTE_LENGTH = 32

  constructor(
    private pendingMfaApprovalRepository: PendingMfaApprovalRepositoryInterface,
    private domainEventPublisher: DomainEventPublisherInterface,
    private domainEventFactory: DomainEventFactoryInterface,
    private logger: Logger,
    private ttlSeconds: number,
  ) {}

  async execute(dto: CreatePendingMfaApprovalDTO): Promise<Result<CreatePendingMfaApprovalResult>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(`Could not create pending MFA approval: ${userUuidOrError.getError()}`)
    }
    const userUuid = userUuidOrError.getValue()

    const challengeId = crypto.randomBytes(this.CHALLENGE_ID_BYTE_LENGTH).toString('base64url')
    const now = Date.now()
    const expiresAt = now + this.ttlSeconds * 1000

    const approvalOrError = PendingMfaApproval.create({
      userUuid: userUuid.value,
      challengeId,
      status: 'pending',
      requestingUserAgent: dto.requestingUserAgent ?? '',
      requestingIpAddress: dto.requestingIpAddress ?? null,
      createdAt: now,
      expiresAt,
      consumed: false,
    })
    if (approvalOrError.isFailed()) {
      return Result.fail(`Could not create pending MFA approval: ${approvalOrError.getError()}`)
    }
    const approval = approvalOrError.getValue()

    await this.pendingMfaApprovalRepository.save(approval)

    // Push an approval-request frame to the user's other authenticated sockets.
    // Best-effort: the new device also polls the status endpoint, so a failed
    // push never blocks the flow.
    try {
      const frame = {
        type: 'MFA_APPROVAL_REQUESTED',
        challengeId,
        requestingUserAgent: approval.props.requestingUserAgent,
        requestingIpAddress: approval.props.requestingIpAddress,
        createdAt: now,
        expiresAt,
      }

      await this.domainEventPublisher.publish(
        this.domainEventFactory.createWebSocketMessageRequestedEvent({
          userUuid: userUuid.value,
          message: JSON.stringify(frame),
        }),
      )
    } catch (error) {
      this.logger.error(`Could not push MFA approval request frame: ${(error as Error).message}`)
    }

    return Result.ok({ challengeId, expiresAt })
  }
}

import { Entity, Result, UniqueEntityId } from '@standardnotes/domain-core'

import { PendingMfaApprovalProps } from './PendingMfaApprovalProps'

export class PendingMfaApproval extends Entity<PendingMfaApprovalProps> {
  private constructor(props: PendingMfaApprovalProps, id?: UniqueEntityId) {
    super(props, id)
  }

  static create(props: PendingMfaApprovalProps, id?: UniqueEntityId): Result<PendingMfaApproval> {
    if (props.userUuid.length === 0) {
      return Result.fail<PendingMfaApproval>('Pending MFA approval user uuid cannot be empty')
    }

    if (props.challengeId.length === 0) {
      return Result.fail<PendingMfaApproval>('Pending MFA approval challenge id cannot be empty')
    }

    if (props.expiresAt <= props.createdAt) {
      return Result.fail<PendingMfaApproval>('Pending MFA approval expiry must be after its creation time')
    }

    return Result.ok<PendingMfaApproval>(new PendingMfaApproval(props, id))
  }

  isExpired(now: number): boolean {
    return this.props.expiresAt <= now
  }

  /**
   * True only when this approval can still be acted upon: it is still pending,
   * not yet consumed, and not expired. Approving/denying/consuming an approval
   * that is not actionable MUST be rejected (single-use + TTL enforcement).
   */
  isActionable(now: number): boolean {
    return this.props.status === 'pending' && !this.props.consumed && !this.isExpired(now)
  }
}

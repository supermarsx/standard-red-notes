import { Entity, Result, UniqueEntityId } from '@standardnotes/domain-core'

import { SignupInviteLinkProps } from './SignupInviteLinkProps'

/**
 * Standard Red Notes: a durable, admin/user-minted signup INVITE link with an
 * atomic per-link account cap ("X accounts"). Modeled on the EmailConfirmationToken
 * entity but stores only the SHA-256 HASH of the raw token (the raw value grants a
 * signup slot, so it is hashed at rest). Slots are consumed atomically in the
 * repository (conditional UPDATE) — the entity's helpers below are for reporting /
 * metadata only and are NEVER the authority on slot availability.
 */
export class SignupInviteLink extends Entity<SignupInviteLinkProps> {
  private constructor(props: SignupInviteLinkProps, id?: UniqueEntityId) {
    super(props, id)
  }

  static create(props: SignupInviteLinkProps, id?: UniqueEntityId): Result<SignupInviteLink> {
    return Result.ok<SignupInviteLink>(new SignupInviteLink(props, id))
  }

  isExpired(now: Date): boolean {
    return this.props.expiresAt !== null && this.props.expiresAt.getTime() <= now.getTime()
  }

  isExhausted(): boolean {
    return this.props.usedCount >= this.props.maxUses
  }

  remainingUses(): number {
    return Math.max(0, this.props.maxUses - this.props.usedCount)
  }

  /**
   * Reporting status for the admin/creator list. Precedence: revoked > expired >
   * exhausted > active. NOT the authority on slot availability (that is the atomic
   * consumeSlot) — this is for display only.
   */
  status(now: Date): 'active' | 'exhausted' | 'expired' | 'revoked' {
    if (this.props.revoked) {
      return 'revoked'
    }
    if (this.isExpired(now)) {
      return 'expired'
    }
    if (this.isExhausted()) {
      return 'exhausted'
    }

    return 'active'
  }

  /** Whether a slot could plausibly be consumed right now (display/quota only). */
  isActive(now: Date): boolean {
    return this.status(now) === 'active'
  }
}

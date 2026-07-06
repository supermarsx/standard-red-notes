import { Entity, Result, UniqueEntityId } from '@standardnotes/domain-core'

import { EmailConfirmationTokenProps } from './EmailConfirmationTokenProps'

/**
 * Standard Red Notes: a single-use, expiring email-confirmation token. Modeled
 * on MagicLinkToken but stores only the SHA-256 HASH of the raw token (the raw
 * value grants confirmation, so it is hashed at rest exactly like an app
 * password / PoW token). Consumed on first successful verification.
 */
export class EmailConfirmationToken extends Entity<EmailConfirmationTokenProps> {
  private constructor(props: EmailConfirmationTokenProps, id?: UniqueEntityId) {
    super(props, id)
  }

  static create(props: EmailConfirmationTokenProps, id?: UniqueEntityId): Result<EmailConfirmationToken> {
    return Result.ok<EmailConfirmationToken>(new EmailConfirmationToken(props, id))
  }

  isExpired(now: Date): boolean {
    return this.props.expiresAt.getTime() <= now.getTime()
  }

  isConsumed(): boolean {
    return this.props.consumed === true
  }

  /** Usable only while not consumed and not expired. */
  isRedeemable(now: Date): boolean {
    return !this.isConsumed() && !this.isExpired(now)
  }
}

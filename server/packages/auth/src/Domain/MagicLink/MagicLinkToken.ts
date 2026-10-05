import { Entity, Result, UniqueEntityId } from '@standardnotes/domain-core'

import { MagicLinkTokenProps } from './MagicLinkTokenProps'

export class MagicLinkToken extends Entity<MagicLinkTokenProps> {
  /**
   * Standard Red Notes: THE PER-CODE ATTEMPT CAP.
   *
   * A magic-link code is six NUMERIC digits (10^6 wide) that stays valid for
   * fifteen minutes, and nothing used to limit how many times it could be
   * guessed: a wrong guess left the token entirely untouched, so the next guess
   * cost exactly as little as the last.
   *
   * The two brakes that do exist — the account lockout counter and the gateway's
   * `auth-second-factor` bucket — are SHARED, account-wide brakes, and that is
   * the defect this cap closes. An attacker who has already spent the account's
   * lockout budget on TOTP has spent the magic-link budget too; worse, spending
   * that shared budget is itself a denial of service against the legitimate
   * owner. Charging the guess to THE CODE has neither property: five wrong
   * guesses kill one six-digit code and nothing else, and the owner asks for
   * another one. The guess budget against any issued code is therefore 5 of
   * 10^6, which is the number that makes a six-digit secret defensible.
   *
   * FIVE is chosen to sit well above a human mistyping a code off a screen
   * (nobody mistypes the same six digits five times) and far below anything that
   * helps a guesser.
   */
  static readonly MAX_FAILED_ATTEMPTS = 5

  private constructor(props: MagicLinkTokenProps, id?: UniqueEntityId) {
    super(props, id)
  }

  static create(props: MagicLinkTokenProps, id?: UniqueEntityId): Result<MagicLinkToken> {
    return Result.ok<MagicLinkToken>(new MagicLinkToken(props, id))
  }

  isExpired(now: Date): boolean {
    return this.props.expiresAt.getTime() <= now.getTime()
  }

  /**
   * True once this code has absorbed its allowance of wrong guesses. An exhausted
   * token is unusable: the CORRECT code must be refused too, or the cap would
   * merely delay the attacker who is about to find it.
   */
  hasExhaustedAttempts(): boolean {
    return this.props.failedAttempts >= MagicLinkToken.MAX_FAILED_ATTEMPTS
  }

  /** Charge one wrong guess to this code. The caller persists the token. */
  registerFailedAttempt(): void {
    this.props.failedAttempts = this.props.failedAttempts + 1
  }
}

import { Entity, Result, UniqueEntityId } from '@standardnotes/domain-core'

import { AppPasswordProps } from './AppPasswordProps'

export class AppPassword extends Entity<AppPasswordProps> {
  /**
   * Recognizable, NON-secret prefix carried by every generated app-password
   * secret (e.g. `srn_ap_<random>`). It makes the value greppable in logs and
   * support channels without exposing anything: the prefix is constant and the
   * entropy lives entirely in the random material that follows it. The full
   * presented string (prefix + random) is what gets hashed and compared, so
   * verification is unaffected.
   */
  static readonly SECRET_PREFIX = 'srn_ap_'

  private constructor(props: AppPasswordProps, id?: UniqueEntityId) {
    super(props, id)
  }

  static create(props: AppPasswordProps, id?: UniqueEntityId): Result<AppPassword> {
    if (props.label.length === 0) {
      return Result.fail<AppPassword>('App password label cannot be empty')
    }

    if (props.label.length > 255) {
      return Result.fail<AppPassword>('App password label cannot be longer than 255 characters')
    }

    return Result.ok<AppPassword>(new AppPassword(props, id))
  }

  isRevoked(): boolean {
    return this.props.revokedAt !== null
  }

  isExpired(now: Date = new Date()): boolean {
    return this.props.expiresAt !== null && this.props.expiresAt.getTime() <= now.getTime()
  }

  /**
   * An app password is only usable while it is neither revoked nor expired.
   * VerifyAppPassword treats a non-active password as a no-match.
   */
  isActive(now: Date = new Date()): boolean {
    return !this.isRevoked() && !this.isExpired(now)
  }

  /**
   * Soft-revoke: record the revocation time and keep the row for the audit
   * trail. No-op if already revoked so the original revocation time is
   * preserved.
   */
  revoke(now: Date = new Date()): void {
    if (this.props.revokedAt === null) {
      this.props.revokedAt = now
    }
  }
}

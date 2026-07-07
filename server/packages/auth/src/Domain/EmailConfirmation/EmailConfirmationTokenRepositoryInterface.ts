import { EmailConfirmationToken } from './EmailConfirmationToken'

export interface EmailConfirmationTokenRepositoryInterface {
  save(token: EmailConfirmationToken): Promise<void>
  /** Constant lookup by the SHA-256 hash of the presented raw token. */
  findByHashedToken(hashedToken: string): Promise<EmailConfirmationToken | null>
  /**
   * Delete every existing token row for a user. Called on (re)issuance BEFORE the
   * new token is saved so only the latest token is ever valid (invalidates prior
   * outstanding tokens) and this user's consumed/expired rows are pruned as a
   * side effect. Bounds per-user rows to one.
   */
  deleteAllForUser(userUuid: string): Promise<void>
  /**
   * Best-effort prune of consumed or expired rows (bounds global table growth for
   * users who never re-request). Returns the number of rows removed.
   */
  deleteExpiredOrConsumed(now: Date): Promise<number>
}

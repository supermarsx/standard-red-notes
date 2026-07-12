import { SignupInviteLink } from './SignupInviteLink'

export interface SignupInviteLinkRepositoryInterface {
  save(link: SignupInviteLink): Promise<void>
  /** Metadata lookup by the SHA-256 hash of the presented raw token. */
  findByHashedToken(hashedToken: string): Promise<SignupInviteLink | null>
  findByUuid(uuid: string): Promise<SignupInviteLink | null>
  /**
   * ATOMIC slot consume. A single conditional UPDATE increments used_count only
   * while the link is valid (not revoked, not exhausted, not expired). Returns
   * true when exactly one row was affected (slot consumed), false otherwise
   * (invalid / exhausted / expired / revoked — indistinguishably). The DB row
   * lock the UPDATE takes serializes concurrent callers, so there is NO
   * read-modify-write gap: two concurrent consumes on a 1-slot link cannot both
   * succeed.
   */
  consumeSlot(hashedToken: string, now: Date): Promise<boolean>
  /** Admin list — every link, newest first. Never returns the raw token. */
  listAll(): Promise<SignupInviteLink[]>
  /** Self-serve list — a single user's own links, newest first. */
  listByCreatorUser(userUuid: string): Promise<SignupInviteLink[]>
  /**
   * Count a user's currently-ACTIVE links (non-revoked, non-exhausted,
   * non-expired) for the per-user self-serve quota. Evaluated in SQL so it is
   * cheap even for a prolific creator.
   */
  countActiveByCreatorUser(userUuid: string, now: Date): Promise<number>
  /** Soft-revoke by uuid. Returns true when a row was flipped to revoked. */
  revokeByUuid(uuid: string): Promise<boolean>
}

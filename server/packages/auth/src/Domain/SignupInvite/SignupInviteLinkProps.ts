/** The kind of principal that minted an invite link. */
export type SignupInviteLinkCreatorKind = 'admin' | 'user'

export interface SignupInviteLinkProps {
  /**
   * The SHA-256 hex digest of the raw token. The raw token is only ever present
   * in the invite URL handed to the admin/creator ONCE at creation; it is NEVER
   * persisted or logged. Lookup is by this hash.
   */
  hashedToken: string
  /** Optional admin/creator note. */
  label: string | null
  /** The "X accounts" cap (1 = single-use, >1 = batch). */
  maxUses: number
  /** Atomically incremented on each consumed slot. */
  usedCount: number
  /** Null = never expires. */
  expiresAt: Date | null
  /** Soft-revoke (never hard-delete, so audit/history survives). */
  revoked: boolean
  /**
   * OPTIONAL per-link role override for accounts created via this link. Only
   * ADMIN links may set it (validated NON-admin); null = use the instance policy.
   */
  defaultRole: string | null
  /**
   * OPTIONAL per-link email-domain lock (only @allowedDomain may consume). Only
   * ADMIN links may set it; null = no per-link domain restriction. Composes with
   * (never widens) the instance-wide domain policy.
   */
  allowedDomain: string | null
  /** The admin uuid that created an ADMIN link (null for user links). */
  createdBy: string | null
  /** The referrer user uuid for a self-serve USER link (null for admin links). */
  createdByUserUuid: string | null
  /** Which principal minted the link. */
  createdByKind: SignupInviteLinkCreatorKind
  /**
   * Whether a signup via this link BYPASSES the approval queue (created already
   * approved). Admin links default true (the admin issuing the link is itself the
   * vetting act); self-serve/user links are forced false (a referred user still
   * faces the queue when approvalRequired is on).
   */
  autoApprove: boolean
  createdAt: Date
  updatedAt: Date
}

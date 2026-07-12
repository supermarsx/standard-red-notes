import { SignupInviteLinkCreatorKind } from '../../SignupInvite/SignupInviteLinkProps'

export interface CreateSignupInviteLinkDTO {
  /** Account cap for the link (1 = single-use, >1 = batch). Clamped 1..100000. */
  maxUses?: number
  /** Hours until expiry, or null/undefined for never-expires. */
  expiresInHours?: number | null
  label?: string | null
  /**
   * Per-link NON-admin role override. HONORED ONLY for admin links — a user link
   * that supplies it is refused (privilege guard).
   */
  defaultRole?: string | null
  /**
   * Per-link email-domain lock. HONORED ONLY for admin links — a user link that
   * supplies it is refused (privilege guard).
   */
  allowedDomain?: string | null
  /**
   * Whether a signup via this link bypasses the approval queue. Admin links
   * default true; user links are ALWAYS forced false regardless of this value.
   */
  autoApprove?: boolean
  /** Which principal is minting the link (governs the privilege guard). */
  creatorKind: SignupInviteLinkCreatorKind
  /** The admin uuid (admin links) — recorded as created_by. */
  adminUuid?: string | null
  /** The referrer user uuid (user links) — recorded as created_by_user_uuid. */
  creatorUserUuid?: string | null
}

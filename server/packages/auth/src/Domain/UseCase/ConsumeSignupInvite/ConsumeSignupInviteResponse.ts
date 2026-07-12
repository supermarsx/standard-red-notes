/**
 * Standard Red Notes: the outcome of attempting to consume a signup invite slot.
 *   - 'consumed': a slot was atomically taken; metadata is attached.
 *   - 'invalid': no such token, domain mismatch, exhausted, expired or revoked —
 *      the four are deliberately indistinguishable (non-enumerable).
 *   - 'error': a DB/infra error occurred (the caller decides fail-open vs
 *      fail-closed based on whether invite-only mode is on).
 */
export type ConsumeSignupInviteResponse =
  | {
      outcome: 'consumed'
      inviteLinkUuid: string
      /** Per-link NON-admin role override, or null to use the instance policy. */
      defaultRole: string | null
      /** Per-link email-domain lock that was satisfied, or null. */
      allowedDomain: string | null
      /** Whether a signup via this link bypasses the approval queue. */
      autoApprove: boolean
      /** The referrer user uuid for a self-serve link, or null for admin links. */
      referrerUserUuid: string | null
    }
  | { outcome: 'invalid' }
  | { outcome: 'error' }

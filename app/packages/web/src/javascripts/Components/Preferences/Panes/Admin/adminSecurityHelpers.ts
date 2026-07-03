/**
 * Standard Red Notes: pure, unit-tested helpers backing the Admin pane's
 * Security overview tab. Keeping the posture logic and audit-event matching
 * here (rather than inline in the React component) keeps them deterministic and
 * testable. This tab is a Phase-1 CENTRALISATION of existing server data — it
 * does not talk to any new endpoints.
 */

// ---------------------------------------------------------------------------
// Registration posture
// ---------------------------------------------------------------------------

/**
 * True when new signups are currently possible. Signups are blocked when EITHER
 * the persisted registration flag is set OR the server's environment
 * (DISABLE_USER_REGISTRATION) blocks them. `envDisabled === null` means the
 * server did not report the env flag (older server) and is treated as "unknown"
 * — i.e. not blocking on its own.
 */
export const registrationIsOpen = (persistedDisabled: boolean, envDisabled: boolean | null): boolean =>
  !(persistedDisabled || envDisabled === true)

/**
 * Where the "signups closed" decision is coming from, for the honesty copy:
 * - 'both'      — persisted flag AND env both block
 * - 'persisted' — only the in-app persisted flag blocks
 * - 'env'       — only the server environment blocks
 * - 'open'      — nothing blocks; signups are open
 */
export type RegistrationBlockSource = 'both' | 'persisted' | 'env' | 'open'

export const registrationBlockSource = (
  persistedDisabled: boolean,
  envDisabled: boolean | null,
): RegistrationBlockSource => {
  const envBlocks = envDisabled === true
  if (persistedDisabled && envBlocks) {
    return 'both'
  }
  if (persistedDisabled) {
    return 'persisted'
  }
  if (envBlocks) {
    return 'env'
  }
  return 'open'
}

// ---------------------------------------------------------------------------
// Audit log — security-relevant event filter
// ---------------------------------------------------------------------------

/**
 * Keywords that mark an admin audit action as security-relevant for the
 * Security tab's "recent events" preview. Matched case-insensitively as a
 * substring of the action name, so both dotted ("login.failure",
 * "role.changed", "ban.changed") and flat ("mfaReset") styles are covered
 * without coupling to an exact server enum.
 */
export const SECURITY_AUDIT_KEYWORDS = [
  'login',
  'signin',
  'sign_in',
  'signed_in',
  'logout',
  'auth',
  'session',
  'token',
  'role',
  'ban',
  'mfa',
  '2fa',
  'password',
  'permission',
  'registration',
  'register',
  'lock',
  'unlock',
]

export const isSecurityRelevantAuditAction = (action: string | null | undefined): boolean => {
  if (!action) {
    return false
  }
  const normalized = action.toLowerCase()
  return SECURITY_AUDIT_KEYWORDS.some((keyword) => normalized.includes(keyword))
}

/**
 * Filter an audit-log page down to the security-relevant entries, preserving
 * the server's (newest-first) order and capping the preview to `limit`.
 */
export const filterSecurityAuditEntries = <T extends { action: string | null }>(entries: T[], limit: number): T[] =>
  entries.filter((entry) => isSecurityRelevantAuditAction(entry.action)).slice(0, Math.max(0, limit))

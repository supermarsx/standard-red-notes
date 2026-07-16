import { RoleName } from '@standardnotes/domain-core'

import { isAssignableDefaultRole } from '../Role/CanonicalRoles'

/**
 * Standard Red Notes: runtime-configurable REGISTRATION policy (admin-set via the
 * gateway ServerSettings overlay, with an env baseline and a hardcoded default).
 * Enforced auth-side in the Register use case. PRECEDENCE mirrors the other
 * overlay-backed settings: persisted (admin) -> env -> default.
 */

export type RegistrationDomainMode = 'off' | 'allowlist' | 'blocklist'

export const REGISTRATION_DOMAIN_MODES: RegistrationDomainMode[] = ['off', 'allowlist', 'blocklist']

/**
 * Standard Red Notes: EMAIL-CONFIRMATION gating mode (only meaningful when
 * emailConfirmationEnabled is true):
 *   - 'block_signin': an unconfirmed user cannot sign in until they confirm (the
 *     strict default when the feature is enabled).
 *   - 'warn': an unconfirmed user may still sign in; they are only flagged.
 */
export type EmailConfirmationGatingMode = 'block_signin' | 'warn'

export const EMAIL_CONFIRMATION_GATING_MODES: EmailConfirmationGatingMode[] = ['block_signin', 'warn']

/**
 * The default confirmation email subject + body. The body MUST contain the
 * `{{confirmation_url}}` placeholder — it is substituted with the per-signup
 * verification link before sending. A configured template that omits the
 * placeholder has the URL appended (see renderConfirmationEmailBody).
 */
export const DEFAULT_EMAIL_CONFIRMATION_SUBJECT = 'Confirm your email address'
export const DEFAULT_EMAIL_CONFIRMATION_BODY =
  'Welcome! Please confirm your email address by opening the link below:\n\n' +
  '{{confirmation_url}}\n\n' +
  'This link expires in 24 hours. If you did not create this account you can ignore this email.'

export const CONFIRMATION_URL_PLACEHOLDER = '{{confirmation_url}}'

/** The fully-resolved policy — every field populated, ready for enforcement. */
export interface RegistrationConfig {
  /** A canonical, NON-admin role name (validated). Defaults to CORE_USER. */
  defaultRole: string
  domainMode: RegistrationDomainMode
  /** Normalized (lowercased, trimmed, de-duped, non-empty) domain list. */
  domainList: string[]
  /**
   * Standard Red Notes: EMAIL CONFIRMATION. OFF by default so existing
   * deployments are unaffected until an admin turns it on. When enabled a new
   * signup is created unconfirmed, emailed a single-use verification link, and
   * gated per emailConfirmationGating on sign-in.
   */
  emailConfirmationEnabled: boolean
  emailConfirmationGating: EmailConfirmationGatingMode
  /** Subject line of the confirmation email. */
  emailConfirmationSubject: string
  /** Body template of the confirmation email (contains {{confirmation_url}}). */
  emailConfirmationBody: string
  /**
   * Absolute base URL of the web app the verification link points at (e.g.
   * `https://notes.example.com`). Empty when unconfigured — the link then falls
   * back to a relative path (only useful behind a same-origin reverse proxy).
   */
  emailConfirmationBaseUrl: string
  /**
   * Standard Red Notes: INVITE-ONLY mode. OFF by default so a stock deploy is
   * unchanged. When ON, registration REQUIRES a valid unique invite URL/token
   * (fail-closed in Register); when OFF a token is optional but still honored +
   * consumed if present (fail-open). See §2.4.
   */
  inviteOnly: boolean
  /**
   * Standard Red Notes: GLOBAL max-total-accounts cap. 0 = unlimited (default).
   * When > 0, Register refuses once the total user count reaches it. FAIL-OPEN on
   * a count error (a broken count never blocks a signup).
   */
  maxTotalAccounts: number
  /**
   * Standard Red Notes: time-windowed signups. Nullable ISO-8601 instants; both
   * null = always open (default). Evaluated against the SERVER clock in UTC:
   * refuse when now < openAt (not yet open) or now > closeAt (closed).
   */
  signupsOpenAt: string | null
  signupsCloseAt: string | null
  /**
   * Standard Red Notes: APPROVAL / WAITLIST QUEUE. OFF by default. When ON, a new
   * signup is created PENDING (access-blocked) and gets no session until an admin
   * approves — UNLESS a consumed invite link has auto_approve (admin links bypass
   * the queue). Orthogonal to inviteOnly (both can be on).
   */
  approvalRequired: boolean
  /**
   * Standard Red Notes: SELF-SERVE / referral invites. The number of ACTIVE
   * invite links a non-admin user may hold. 0 = self-serve DISABLED (default).
   */
  invitesPerUser: number
}

/**
 * A partial admin overlay read from the persisted ServerSettings JSON
 * (`registration.*`). Any field left undefined falls back to the env baseline /
 * default. Field names mirror the persisted contract shared with the gateway.
 */
export interface RegistrationConfigOverlay {
  defaultRole?: string
  domainMode?: RegistrationDomainMode
  domainList?: string[]
  emailConfirmationEnabled?: boolean
  emailConfirmationGating?: EmailConfirmationGatingMode
  emailConfirmationSubject?: string
  emailConfirmationBody?: string
  emailConfirmationBaseUrl?: string
  inviteOnly?: boolean
  maxTotalAccounts?: number
  signupsOpenAt?: string | null
  signupsCloseAt?: string | null
  approvalRequired?: boolean
  invitesPerUser?: number
}

export const DEFAULT_REGISTRATION_CONFIG: RegistrationConfig = {
  defaultRole: RoleName.NAMES.CoreUser,
  domainMode: 'off',
  domainList: [],
  emailConfirmationEnabled: false,
  emailConfirmationGating: 'block_signin',
  emailConfirmationSubject: DEFAULT_EMAIL_CONFIRMATION_SUBJECT,
  emailConfirmationBody: DEFAULT_EMAIL_CONFIRMATION_BODY,
  emailConfirmationBaseUrl: '',
  inviteOnly: false,
  maxTotalAccounts: 0,
  signupsOpenAt: null,
  signupsCloseAt: null,
  approvalRequired: false,
  invitesPerUser: 0,
}

export const isRegistrationDomainMode = (value: unknown): value is RegistrationDomainMode =>
  typeof value === 'string' && (REGISTRATION_DOMAIN_MODES as string[]).includes(value)

export const isEmailConfirmationGatingMode = (value: unknown): value is EmailConfirmationGatingMode =>
  typeof value === 'string' && (EMAIL_CONFIRMATION_GATING_MODES as string[]).includes(value)

/**
 * Standard Red Notes: composes the verification link a confirmation email points
 * at. The web app reads the raw token from the `email_confirmation` query param
 * on the root route (see the web RouteParser). The token is URL-encoded; the
 * base URL has any trailing slash trimmed. An empty base yields a relative link.
 */
export const buildConfirmationUrl = (baseUrl: string, token: string): string => {
  const base = (baseUrl ?? '').trim().replace(/\/+$/, '')
  const query = `?email_confirmation=${encodeURIComponent(token)}`

  return base.length === 0 ? `/${query}` : `${base}/${query}`
}

/**
 * Substitutes the {{confirmation_url}} placeholder in a (possibly
 * admin-customized) body template. When the template does not contain the
 * placeholder the link is appended on its own line so a misconfigured template
 * never sends an email with no usable link.
 */
export const renderConfirmationEmailBody = (template: string, url: string): string => {
  const body = typeof template === 'string' && template.trim().length > 0 ? template : DEFAULT_EMAIL_CONFIRMATION_BODY
  if (body.includes(CONFIRMATION_URL_PLACEHOLDER)) {
    return body.split(CONFIRMATION_URL_PLACEHOLDER).join(url)
  }

  return `${body}\n\n${url}`
}

/**
 * Coerces a configured default-role value to a valid one: only a canonical,
 * NON-admin role name is accepted; anything else (unknown role, the admin role,
 * empty) falls back to CORE_USER. This guarantees a new signup is NEVER given
 * the admin role by misconfiguration.
 */
export const sanitizeDefaultRole = (value: string | undefined): string => {
  if (value !== undefined && isAssignableDefaultRole(value)) {
    return value
  }

  return RoleName.NAMES.CoreUser
}

/**
 * Normalizes a raw domain list: lowercases, trims, strips a leading '@' or '.',
 * drops empties and de-dupes while preserving order.
 */
export const normalizeDomainList = (list: string[] | undefined): string[] => {
  if (!Array.isArray(list)) {
    return []
  }

  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of list) {
    if (typeof raw !== 'string') {
      continue
    }
    const normalized = raw
      .trim()
      .toLowerCase()
      .replace(/^[@.]+/, '')
    if (normalized.length === 0 || seen.has(normalized)) {
      continue
    }
    seen.add(normalized)
    result.push(normalized)
  }

  return result
}

/**
 * Standard Red Notes: normalizes a configured signup-window bound to a valid
 * absolute ISO-8601 instant string, or null. A non-string, empty or unparseable
 * value clears to null so a bad value can never wedge signups shut. The value is
 * canonicalized to the instant's ISO string (UTC) so comparison is unambiguous.
 */
export const normalizeSignupWindowValue = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null
  }
  const parsed = new Date(value.trim())
  if (Number.isNaN(parsed.getTime())) {
    return null
  }

  return parsed.toISOString()
}

/**
 * Standard Red Notes: clamps a configured max-total-accounts value to a
 * non-negative safe integer (0 = unlimited). Anything invalid falls back to 0.
 */
export const normalizeMaxTotalAccounts = (value: unknown): number => {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    return 0
  }

  return Math.min(n, Number.MAX_SAFE_INTEGER)
}

/** Extracts the lowercased domain (after the last '@') from an email address. */
export const emailDomain = (email: string): string => {
  const at = email.lastIndexOf('@')
  if (at < 0) {
    return ''
  }

  return email
    .slice(at + 1)
    .trim()
    .toLowerCase()
}

/**
 * SUBDOMAIN RULE (documented contract): a listed domain `d` matches a candidate
 * domain `c` when they are equal OR `c` is a subdomain of `d` — i.e.
 * `c === d` or `c` ends with `"." + d`. Matching is case-insensitive.
 *
 * So listing `example.com` matches `example.com`, `mail.example.com` and
 * `a.b.example.com`, but NOT `notexample.com` (the label boundary is required)
 * and NOT a bare parent like `com`.
 */
export const domainMatchesList = (candidate: string, list: string[]): boolean => {
  if (candidate.length === 0) {
    return false
  }

  return list.some((listed) => candidate === listed || candidate.endsWith(`.${listed}`))
}

/**
 * Whether an email is permitted to register under the given policy:
 *   - off (or an empty list)  -> always allowed
 *   - allowlist               -> allowed only when the domain matches the list
 *   - blocklist               -> refused when the domain matches the list
 * Uses the subdomain rule above. An email with no parseable domain is treated as
 * NOT matching the list (so it is refused under allowlist, allowed under
 * blocklist) — the address itself is validated separately by Username.create.
 */
export const emailAllowedByPolicy = (email: string, config: RegistrationConfig): boolean => {
  if (config.domainMode === 'off' || config.domainList.length === 0) {
    return true
  }

  const domain = emailDomain(email)
  const matches = domainMatchesList(domain, config.domainList)

  return config.domainMode === 'allowlist' ? matches : !matches
}

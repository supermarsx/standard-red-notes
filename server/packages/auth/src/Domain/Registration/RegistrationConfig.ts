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

/** The fully-resolved policy — every field populated, ready for enforcement. */
export interface RegistrationConfig {
  /** A canonical, NON-admin role name (validated). Defaults to CORE_USER. */
  defaultRole: string
  domainMode: RegistrationDomainMode
  /** Normalized (lowercased, trimmed, de-duped, non-empty) domain list. */
  domainList: string[]
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
}

export const DEFAULT_REGISTRATION_CONFIG: RegistrationConfig = {
  defaultRole: RoleName.NAMES.CoreUser,
  domainMode: 'off',
  domainList: [],
}

export const isRegistrationDomainMode = (value: unknown): value is RegistrationDomainMode =>
  typeof value === 'string' && (REGISTRATION_DOMAIN_MODES as string[]).includes(value)

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
    const normalized = raw.trim().toLowerCase().replace(/^[@.]+/, '')
    if (normalized.length === 0 || seen.has(normalized)) {
      continue
    }
    seen.add(normalized)
    result.push(normalized)
  }

  return result
}

/** Extracts the lowercased domain (after the last '@') from an email address. */
export const emailDomain = (email: string): string => {
  const at = email.lastIndexOf('@')
  if (at < 0) {
    return ''
  }

  return email.slice(at + 1).trim().toLowerCase()
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

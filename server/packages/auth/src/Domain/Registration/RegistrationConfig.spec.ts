import { RoleName } from '@standardnotes/domain-core'

import {
  buildConfirmationUrl,
  DEFAULT_EMAIL_CONFIRMATION_BODY,
  DEFAULT_REGISTRATION_CONFIG,
  domainMatchesList,
  EMAIL_CONFIRMATION_GATING_MODES,
  emailAllowedByPolicy,
  emailDomain,
  isEmailConfirmationGatingMode,
  isRegistrationDomainMode,
  normalizeMaxTotalAccounts,
  normalizeDomainList,
  normalizeSignupWindowValue,
  REGISTRATION_DOMAIN_MODES,
  RegistrationConfig,
  renderConfirmationEmailBody,
  sanitizeDefaultRole,
} from './RegistrationConfig'

describe('RegistrationConfig helpers', () => {
  describe('policy mode guards', () => {
    it('accepts every supported mode and rejects non-string or unknown values', () => {
      expect(REGISTRATION_DOMAIN_MODES.every(isRegistrationDomainMode)).toBe(true)
      expect(EMAIL_CONFIRMATION_GATING_MODES.every(isEmailConfirmationGatingMode)).toBe(true)
      expect(isRegistrationDomainMode('denylist')).toBe(false)
      expect(isRegistrationDomainMode(null)).toBe(false)
      expect(isEmailConfirmationGatingMode('silent')).toBe(false)
      expect(isEmailConfirmationGatingMode(1)).toBe(false)
    })
  })

  describe('sanitizeDefaultRole', () => {
    it('accepts a canonical non-admin role', () => {
      expect(sanitizeDefaultRole(RoleName.NAMES.ProUser)).toEqual(RoleName.NAMES.ProUser)
      expect(sanitizeDefaultRole(RoleName.NAMES.VaultsUser)).toEqual(RoleName.NAMES.VaultsUser)
      expect(sanitizeDefaultRole(RoleName.NAMES.CoreUser)).toEqual(RoleName.NAMES.CoreUser)
    })

    it('rejects the admin role and falls back to CORE_USER', () => {
      expect(sanitizeDefaultRole(RoleName.NAMES.AdminUser)).toEqual(RoleName.NAMES.CoreUser)
    })

    it('rejects an unknown/legacy role and falls back to CORE_USER', () => {
      expect(sanitizeDefaultRole('PLUS_USER')).toEqual(RoleName.NAMES.CoreUser)
      expect(sanitizeDefaultRole('NONSENSE')).toEqual(RoleName.NAMES.CoreUser)
      expect(sanitizeDefaultRole(undefined)).toEqual(RoleName.NAMES.CoreUser)
      expect(sanitizeDefaultRole('')).toEqual(RoleName.NAMES.CoreUser)
    })
  })

  describe('normalizeDomainList', () => {
    it('lowercases, trims, strips leading @/., drops empties and de-dupes', () => {
      expect(normalizeDomainList([' Example.COM ', '@foo.com', '.bar.com', '', 'example.com'])).toEqual([
        'example.com',
        'foo.com',
        'bar.com',
      ])
    })

    it('returns an empty list for a non-array', () => {
      expect(normalizeDomainList(undefined)).toEqual([])
    })

    it('ignores non-string entries supplied by an untyped settings payload', () => {
      expect(normalizeDomainList(['valid.example', 42 as unknown as string])).toEqual(['valid.example'])
    })
  })

  describe('emailDomain', () => {
    it('extracts the lowercased domain', () => {
      expect(emailDomain('Person@Example.COM')).toEqual('example.com')
    })

    it('returns empty when there is no @', () => {
      expect(emailDomain('not-an-email')).toEqual('')
    })
  })

  describe('domainMatchesList (subdomain rule)', () => {
    const list = ['example.com']

    it('matches the exact domain', () => {
      expect(domainMatchesList('example.com', list)).toBe(true)
    })

    it('matches a subdomain at any depth', () => {
      expect(domainMatchesList('mail.example.com', list)).toBe(true)
      expect(domainMatchesList('a.b.example.com', list)).toBe(true)
    })

    it('does NOT match a look-alike parent-suffix that breaks the label boundary', () => {
      expect(domainMatchesList('notexample.com', list)).toBe(false)
    })

    it('does NOT match a bare parent', () => {
      expect(domainMatchesList('com', list)).toBe(false)
    })

    it('an empty candidate never matches', () => {
      expect(domainMatchesList('', list)).toBe(false)
    })
  })

  describe('emailAllowedByPolicy', () => {
    const config = (over: Partial<RegistrationConfig>): RegistrationConfig => ({
      ...DEFAULT_REGISTRATION_CONFIG,
      defaultRole: RoleName.NAMES.CoreUser,
      domainMode: 'off',
      domainList: [],
      ...over,
    })

    it('off -> always allowed', () => {
      expect(emailAllowedByPolicy('a@blocked.com', config({ domainMode: 'off', domainList: ['blocked.com'] }))).toBe(
        true,
      )
    })

    it('empty list -> always allowed even when a mode is set', () => {
      expect(emailAllowedByPolicy('a@x.com', config({ domainMode: 'allowlist', domainList: [] }))).toBe(true)
    })

    it('allowlist -> only listed domains (and subdomains) allowed', () => {
      const c = config({ domainMode: 'allowlist', domainList: ['company.com'] })
      expect(emailAllowedByPolicy('a@company.com', c)).toBe(true)
      expect(emailAllowedByPolicy('a@eu.company.com', c)).toBe(true)
      expect(emailAllowedByPolicy('a@other.com', c)).toBe(false)
    })

    it('blocklist -> listed domains (and subdomains) refused', () => {
      const c = config({ domainMode: 'blocklist', domainList: ['spam.com'] })
      expect(emailAllowedByPolicy('a@spam.com', c)).toBe(false)
      expect(emailAllowedByPolicy('a@mx.spam.com', c)).toBe(false)
      expect(emailAllowedByPolicy('a@good.com', c)).toBe(true)
    })

    it('is case-insensitive on the email domain', () => {
      const c = config({ domainMode: 'allowlist', domainList: ['company.com'] })
      expect(emailAllowedByPolicy('a@Company.COM', c)).toBe(true)
    })

    it('treats an unparseable (no @) address as not matching the list', () => {
      expect(emailAllowedByPolicy('no-at-sign', config({ domainMode: 'allowlist', domainList: ['company.com'] }))).toBe(
        false,
      )
      expect(emailAllowedByPolicy('no-at-sign', config({ domainMode: 'blocklist', domainList: ['company.com'] }))).toBe(
        true,
      )
    })
  })

  describe('buildConfirmationUrl', () => {
    it('composes an absolute link with the token url-encoded on the root route', () => {
      expect(buildConfirmationUrl('https://notes.example.com/', 'ab cd')).toBe(
        'https://notes.example.com/?email_confirmation=ab%20cd',
      )
      expect(buildConfirmationUrl('https://notes.example.com', 'tok')).toBe(
        'https://notes.example.com/?email_confirmation=tok',
      )
    })

    it('falls back to a relative link when no base URL is configured', () => {
      expect(buildConfirmationUrl('', 'tok')).toBe('/?email_confirmation=tok')
      expect(buildConfirmationUrl(null as unknown as string, 'tok')).toBe('/?email_confirmation=tok')
    })
  })

  describe('renderConfirmationEmailBody', () => {
    it('substitutes every {{confirmation_url}} placeholder', () => {
      expect(renderConfirmationEmailBody('Go: {{confirmation_url}} now', 'https://x/y')).toBe('Go: https://x/y now')
    })

    it('appends the link when the template omits the placeholder', () => {
      expect(renderConfirmationEmailBody('No placeholder here', 'https://x/y')).toBe(
        'No placeholder here\n\nhttps://x/y',
      )
    })

    it('uses the secure default body when the configured template is blank', () => {
      expect(renderConfirmationEmailBody('   ', 'https://x/y')).toBe(
        DEFAULT_EMAIL_CONFIRMATION_BODY.replace('{{confirmation_url}}', 'https://x/y'),
      )
    })
  })

  describe('signup window normalization', () => {
    it('clears missing, blank, and invalid bounds', () => {
      expect(normalizeSignupWindowValue(undefined)).toBeNull()
      expect(normalizeSignupWindowValue('  ')).toBeNull()
      expect(normalizeSignupWindowValue('not-a-date')).toBeNull()
    })

    it('canonicalizes a valid absolute instant to UTC', () => {
      expect(normalizeSignupWindowValue('2026-07-15T12:30:00+02:00')).toBe('2026-07-15T10:30:00.000Z')
    })
  })

  describe('account cap normalization', () => {
    it('accepts non-negative safe integers and clamps oversized input', () => {
      expect(normalizeMaxTotalAccounts(0)).toBe(0)
      expect(normalizeMaxTotalAccounts('12')).toBe(12)
      expect(normalizeMaxTotalAccounts(Number.MAX_VALUE)).toBe(Number.MAX_SAFE_INTEGER)
      expect(normalizeMaxTotalAccounts(Number.MAX_SAFE_INTEGER + 1)).toBe(Number.MAX_SAFE_INTEGER)
    })

    it('falls back to unlimited for negative, fractional, or non-numeric input', () => {
      expect(normalizeMaxTotalAccounts(-1)).toBe(0)
      expect(normalizeMaxTotalAccounts(1.5)).toBe(0)
      expect(normalizeMaxTotalAccounts('invalid')).toBe(0)
    })
  })
})

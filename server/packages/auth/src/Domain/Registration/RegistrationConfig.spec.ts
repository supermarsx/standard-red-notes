import { RoleName } from '@standardnotes/domain-core'

import {
  domainMatchesList,
  emailAllowedByPolicy,
  emailDomain,
  normalizeDomainList,
  RegistrationConfig,
  sanitizeDefaultRole,
} from './RegistrationConfig'

describe('RegistrationConfig helpers', () => {
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
      defaultRole: RoleName.NAMES.CoreUser,
      domainMode: 'off',
      domainList: [],
      ...over,
    })

    it('off -> always allowed', () => {
      expect(emailAllowedByPolicy('a@blocked.com', config({ domainMode: 'off', domainList: ['blocked.com'] }))).toBe(true)
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
})

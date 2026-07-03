import {
  filterSecurityAuditEntries,
  isSecurityRelevantAuditAction,
  registrationBlockSource,
  registrationIsOpen,
} from './adminSecurityHelpers'

describe('registrationIsOpen', () => {
  it('is open when neither the persisted flag nor the env blocks', () => {
    expect(registrationIsOpen(false, false)).toBe(true)
    expect(registrationIsOpen(false, null)).toBe(true)
  })

  it('is closed when the persisted flag blocks', () => {
    expect(registrationIsOpen(true, false)).toBe(false)
    expect(registrationIsOpen(true, null)).toBe(false)
  })

  it('is closed when the environment blocks', () => {
    expect(registrationIsOpen(false, true)).toBe(false)
    expect(registrationIsOpen(true, true)).toBe(false)
  })
})

describe('registrationBlockSource', () => {
  it('reports which layer is blocking signups', () => {
    expect(registrationBlockSource(false, false)).toBe('open')
    expect(registrationBlockSource(false, null)).toBe('open')
    expect(registrationBlockSource(true, false)).toBe('persisted')
    expect(registrationBlockSource(true, null)).toBe('persisted')
    expect(registrationBlockSource(false, true)).toBe('env')
    expect(registrationBlockSource(true, true)).toBe('both')
  })
})

describe('isSecurityRelevantAuditAction', () => {
  it('matches security-relevant actions case-insensitively', () => {
    expect(isSecurityRelevantAuditAction('login.failure')).toBe(true)
    expect(isSecurityRelevantAuditAction('role.changed')).toBe(true)
    expect(isSecurityRelevantAuditAction('ban.changed')).toBe(true)
    expect(isSecurityRelevantAuditAction('user.signed_in')).toBe(true)
    expect(isSecurityRelevantAuditAction('MFA_RESET')).toBe(true)
    expect(isSecurityRelevantAuditAction('password.reset')).toBe(true)
    expect(isSecurityRelevantAuditAction('registration.flag.changed')).toBe(true)
  })

  it('ignores non-security actions and empty input', () => {
    expect(isSecurityRelevantAuditAction('quota.recalculated')).toBe(false)
    expect(isSecurityRelevantAuditAction('webhook.created')).toBe(false)
    expect(isSecurityRelevantAuditAction('')).toBe(false)
    expect(isSecurityRelevantAuditAction(null)).toBe(false)
    expect(isSecurityRelevantAuditAction(undefined)).toBe(false)
  })
})

describe('filterSecurityAuditEntries', () => {
  const entries = [
    { action: 'login.failure' },
    { action: 'quota.recalculated' },
    { action: 'role.changed' },
    { action: 'webhook.created' },
    { action: 'ban.changed' },
    { action: null },
  ]

  it('keeps only security-relevant entries, preserving order', () => {
    expect(filterSecurityAuditEntries(entries, 10).map((entry) => entry.action)).toEqual([
      'login.failure',
      'role.changed',
      'ban.changed',
    ])
  })

  it('caps the result at the requested limit', () => {
    expect(filterSecurityAuditEntries(entries, 2).map((entry) => entry.action)).toEqual([
      'login.failure',
      'role.changed',
    ])
    expect(filterSecurityAuditEntries(entries, 0)).toEqual([])
  })
})

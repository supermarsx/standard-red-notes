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

  it('matches changes to sensitive settings and to credentials', () => {
    // These were already written server-side but had no matching keyword, so
    // they never reached the "Recent security events" preview.
    expect(isSecurityRelevantAuditAction('setting.changed')).toBe(true)
    expect(isSecurityRelevantAuditAction('setting.deleted')).toBe(true)
    expect(isSecurityRelevantAuditAction('credentials.changed')).toBe(true)
    expect(isSecurityRelevantAuditAction('credentials.change_failed')).toBe(true)
    expect(isSecurityRelevantAuditAction('mfa.enabled')).toBe(true)
    expect(isSecurityRelevantAuditAction('mfa.disabled')).toBe(true)
    expect(isSecurityRelevantAuditAction('mfa.change_failed')).toBe(true)
  })

  it('matches privilege attributions, including ones conferred through a group', () => {
    expect(isSecurityRelevantAuditAction('group.changed')).toBe(true)
    expect(isSecurityRelevantAuditAction('group.membership_changed')).toBe(true)
    expect(isSecurityRelevantAuditAction('invite_link.created')).toBe(true)
    expect(isSecurityRelevantAuditAction('invite_link.revoked')).toBe(true)
    expect(isSecurityRelevantAuditAction('user.approved')).toBe(true)
    expect(isSecurityRelevantAuditAction('user.rejected')).toBe(true)
  })

  it('matches account-level state changes', () => {
    expect(isSecurityRelevantAuditAction('user.account_deleted')).toBe(true)
    expect(isSecurityRelevantAuditAction('user.suspension_changed')).toBe(true)
    expect(isSecurityRelevantAuditAction('account.unlocked')).toBe(true)
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

  it('surfaces sensitive-setting and attribution events alongside the sign-in events', () => {
    const mixed = [
      { action: 'credentials.change_failed' },
      { action: 'quota.recalculated' },
      { action: 'mfa.disabled' },
      { action: 'setting.changed' },
      { action: 'group.membership_changed' },
    ]

    expect(filterSecurityAuditEntries(mixed, 10).map((entry) => entry.action)).toEqual([
      'credentials.change_failed',
      'mfa.disabled',
      'setting.changed',
      'group.membership_changed',
    ])
  })
})

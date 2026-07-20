import { normalizeCustomRoleName } from './CustomRoleName'

describe('normalizeCustomRoleName', () => {
  it('returns null for a non-string input', () => {
    expect(normalizeCustomRoleName(null)).toBeNull()
    expect(normalizeCustomRoleName(undefined)).toBeNull()
  })

  it('upper-cases and collapses separators into single underscores', () => {
    expect(normalizeCustomRoleName('Support Agent')).toEqual('SUPPORT_AGENT')
    expect(normalizeCustomRoleName('billing   ops')).toEqual('BILLING_OPS')
    expect(normalizeCustomRoleName('tier-2/support')).toEqual('TIER_2_SUPPORT')
  })

  it('trims surrounding whitespace and leading/trailing underscores', () => {
    expect(normalizeCustomRoleName('  _support agent_  ')).toEqual('SUPPORT_AGENT')
    expect(normalizeCustomRoleName('!!admin!!')).toEqual('ADMIN')
  })

  it('returns null when nothing usable remains', () => {
    expect(normalizeCustomRoleName('')).toBeNull()
    expect(normalizeCustomRoleName('   ')).toBeNull()
    expect(normalizeCustomRoleName('---!!!---')).toBeNull()
  })
})

import { emptyAdminUsersFilterState } from './adminHelpers'
import { describeAdminUsersActiveFilters } from './adminUsersUi'

describe('describeAdminUsersActiveFilters', () => {
  const base = emptyAdminUsersFilterState()

  it('returns no chips for the empty filter state', () => {
    expect(describeAdminUsersActiveFilters(base)).toEqual([])
  })

  it('ignores whitespace-only email search', () => {
    expect(describeAdminUsersActiveFilters({ ...base, email: '   ' })).toEqual([])
  })

  it('describes a trimmed email search', () => {
    expect(describeAdminUsersActiveFilters({ ...base, email: ' a@b.com ' })).toEqual([
      { key: 'email', label: 'Email contains "a@b.com"' },
    ])
  })

  it('describes each subscription filter value', () => {
    expect(describeAdminUsersActiveFilters({ ...base, subscription: 'active' })[0].label).toBe('Active subscription')
    expect(describeAdminUsersActiveFilters({ ...base, subscription: 'inactive' })[0].label).toBe(
      'Inactive subscription',
    )
    expect(describeAdminUsersActiveFilters({ ...base, subscription: 'none' })[0].label).toBe('No subscription')
  })

  it('describes both banned filter values', () => {
    expect(describeAdminUsersActiveFilters({ ...base, banned: 'yes' })[0].label).toBe('Banned only')
    expect(describeAdminUsersActiveFilters({ ...base, banned: 'no' })[0].label).toBe('Not banned')
  })

  it('describes role and date bounds', () => {
    expect(describeAdminUsersActiveFilters({ ...base, role: 'PRO_USER' })[0]).toEqual({
      key: 'role',
      label: 'Role: PRO_USER',
    })
    expect(describeAdminUsersActiveFilters({ ...base, createdAfter: '2026-01-01' })[0].label).toBe(
      'Created after 2026-01-01',
    )
    expect(describeAdminUsersActiveFilters({ ...base, createdBefore: '2026-02-01' })[0].label).toBe(
      'Created before 2026-02-01',
    )
  })

  it('lists every active filter, in control order', () => {
    const chips = describeAdminUsersActiveFilters({
      email: 'x',
      subscription: 'none',
      banned: 'yes',
      role: 'CORE_USER',
      createdAfter: '2026-01-01',
      createdBefore: '2026-02-01',
    })
    expect(chips.map((chip) => chip.key)).toEqual([
      'email',
      'subscription',
      'banned',
      'role',
      'createdAfter',
      'createdBefore',
    ])
  })
})

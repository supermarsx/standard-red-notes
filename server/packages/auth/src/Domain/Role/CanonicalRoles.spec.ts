import { RoleName } from '@standardnotes/domain-core'

import {
  ASSIGNABLE_DEFAULT_ROLE_NAMES,
  CANONICAL_ADMIN_ROLE_NAMES,
  CANONICAL_ADMIN_ROLES,
  canonicalAdminRoleDescription,
  canonicalAdminRoleLabel,
  canonicalAdminRoleOrder,
  isAssignableDefaultRole,
  isCanonicalAdminRole,
} from './CanonicalRoles'

describe('CanonicalRoles', () => {
  it('defines the four admin-facing roles in their stable display order', () => {
    expect(CANONICAL_ADMIN_ROLE_NAMES).toEqual([
      RoleName.NAMES.AdminUser,
      RoleName.NAMES.ProUser,
      RoleName.NAMES.CoreUser,
      RoleName.NAMES.VaultsUser,
    ])
    expect(CANONICAL_ADMIN_ROLES.map((role) => role.label)).toEqual([
      'Admin user',
      'Full user',
      'Core user',
      'Vaults user',
    ])
  })

  it('allows only non-admin canonical roles as signup defaults', () => {
    expect(ASSIGNABLE_DEFAULT_ROLE_NAMES).toEqual([
      RoleName.NAMES.ProUser,
      RoleName.NAMES.CoreUser,
      RoleName.NAMES.VaultsUser,
    ])
    expect(isAssignableDefaultRole(RoleName.NAMES.ProUser)).toBe(true)
    expect(isAssignableDefaultRole(RoleName.NAMES.AdminUser)).toBe(false)
    expect(isAssignableDefaultRole('UNKNOWN_ROLE')).toBe(false)
  })

  it('returns metadata for canonical roles and safe fallbacks for unknown roles', () => {
    expect(isCanonicalAdminRole(RoleName.NAMES.CoreUser)).toBe(true)
    expect(isCanonicalAdminRole('UNKNOWN_ROLE')).toBe(false)
    expect(canonicalAdminRoleLabel(RoleName.NAMES.CoreUser)).toBe('Core user')
    expect(canonicalAdminRoleLabel('UNKNOWN_ROLE')).toBeNull()
    expect(canonicalAdminRoleDescription(RoleName.NAMES.VaultsUser)).toContain('shared vaults')
    expect(canonicalAdminRoleDescription('UNKNOWN_ROLE')).toBeNull()
    expect(canonicalAdminRoleOrder(RoleName.NAMES.AdminUser)).toBe(0)
    expect(canonicalAdminRoleOrder(RoleName.NAMES.VaultsUser)).toBe(3)
    expect(canonicalAdminRoleOrder('UNKNOWN_ROLE')).toBe(Number.MAX_SAFE_INTEGER)
  })
})

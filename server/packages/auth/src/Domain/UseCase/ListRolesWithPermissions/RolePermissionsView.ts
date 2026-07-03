/**
 * Standard Red Notes: a single role as presented to the admin roles panel — the
 * active (highest-version) role row for a name, its granted permissions, and
 * whether it is a built-in role (a member of the canonical RoleName enum, which
 * is protected: its permission assignments are editable, but the role type
 * itself cannot be created/renamed/deleted at runtime).
 */
export interface RolePermissionsView {
  uuid: string
  name: string
  /** Standard Red Notes: the canonical human label ('Admin user', 'Full user', …). */
  label: string
  version: number
  isBuiltIn: boolean
  /**
   * Standard Red Notes: the inverse of isBuiltIn — a role that is NOT a member of
   * the canonical RoleName enum, i.e. an admin-created CUSTOM role. Custom roles
   * may be renamed/deleted (when unused) and are only conferred through groups.
   */
  isCustom: boolean
  /** Standard Red Notes: optional human description (custom roles only). */
  description: string | null
  permissionNames: string[]
}

/**
 * Standard Red Notes: the full roles-management payload — every active role with
 * its permissions, plus the seeded permission CATALOG the picker draws from.
 */
export interface RolesWithPermissions {
  roles: RolePermissionsView[]
  permissions: string[]
  builtInRoleNames: string[]
}

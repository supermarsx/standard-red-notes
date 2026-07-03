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
  version: number
  isBuiltIn: boolean
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

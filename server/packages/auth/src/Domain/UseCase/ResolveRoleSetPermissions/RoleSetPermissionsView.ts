/**
 * Standard Red Notes: result of resolving an arbitrary SET of role names to the
 * union of the permissions they grant — the admin "effective permissions
 * simulator". `perRole` breaks the union down per resolved role;
 * `unknownRoleNames` lists requested names that matched no role row.
 */
export interface RoleSetPermissionsView {
  roleNames: string[]
  unknownRoleNames: string[]
  effectivePermissionNames: string[]
  perRole: Array<{ name: string; permissionNames: string[] }>
}

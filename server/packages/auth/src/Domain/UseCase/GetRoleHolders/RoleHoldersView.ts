/**
 * Standard Red Notes: "who has this role" summary for the admin role inspector.
 *   - directUserCount: users the role is assigned to directly (user_roles);
 *   - groups: the RBAC groups that confer the role on their members.
 */
export interface RoleHoldersView {
  uuid: string
  name: string
  directUserCount: number
  groups: Array<{ uuid: string; name: string }>
}

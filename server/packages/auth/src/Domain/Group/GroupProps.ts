export interface GroupProps {
  name: string
  description: string | null
  createdAt: Date
  updatedAt: Date
  /**
   * Standard Red Notes: the set of role NAMES (e.g. CORE_USER, PRO_USER,
   * INTERNAL_TEAM_USER) this group confers on every member. Membership in the
   * group grants the union of these roles' permissions on top of the user's own
   * directly-assigned roles. Empty means the group currently grants nothing.
   */
  roleNames: string[]
}

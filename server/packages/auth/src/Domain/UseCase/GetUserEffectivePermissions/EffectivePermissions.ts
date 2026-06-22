export interface EffectivePermissions {
  userUuid: string
  /**
   * Role names assigned directly to the user (via the `user_roles` table).
   */
  directRoleNames: string[]
  /**
   * Role names conferred by the user's group memberships (union across all
   * groups the user belongs to).
   */
  groupRoleNames: string[]
  /**
   * The union of directRoleNames and groupRoleNames.
   */
  effectiveRoleNames: string[]
  /**
   * The union of every permission name granted by the effective roles. This is
   * the user's effective permission set = (direct roles) ∪ (group roles),
   * resolved through the existing role -> permission mapping.
   */
  effectivePermissionNames: string[]
}

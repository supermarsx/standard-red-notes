export interface UserPermissionChangedInSharedVaultEventPayload {
  sharedVaultUuid: string
  userUuid: string
  /** The permission the membership row now carries. */
  permission: string
  /** The permission it carried before the change, for consumers that audit transitions. */
  previousPermission: string
  /** Who performed the change. Never the subject: self-service changes are refused. */
  originatorUuid: string
  updatedAt: number
}

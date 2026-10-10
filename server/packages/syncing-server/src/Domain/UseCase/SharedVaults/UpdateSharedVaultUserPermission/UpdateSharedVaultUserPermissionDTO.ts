export interface UpdateSharedVaultUserPermissionDTO {
  sharedVaultUuid: string
  /** The member whose permission changes. Never the originator -- see the use case. */
  userUuid: string
  originatorUuid: string
  /** One of SharedVaultUserPermission.PERMISSIONS; anything else is refused. */
  permission: string
}

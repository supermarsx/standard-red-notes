/**
 * The three values `SharedVaultUserPermission` accepts server-side. Spelled out here
 * rather than typed as `string` so a caller cannot send a permission the server will
 * only refuse at the far end of a round trip.
 */
export type SharedVaultUserPermissionValue = 'read' | 'write' | 'admin'

export type UpdateSharedVaultUserPermissionRequestParams = {
  sharedVaultUuid: string
  userUuid: string
  permission: SharedVaultUserPermissionValue
}

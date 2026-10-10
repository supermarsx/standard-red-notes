export const SharedVaultUsersPaths = {
  getSharedVaultUsers: (sharedVaultUuid: string) => `/v1/shared-vaults/${sharedVaultUuid}/users`,
  deleteSharedVaultUser: (sharedVaultUuid: string, userUuid: string) =>
    `/v1/shared-vaults/${sharedVaultUuid}/users/${userUuid}`,
  // Same path as the removal, distinguished by the PATCH verb -- the gateway resolves
  // '[PATCH]:shared-vaults/:sharedVaultUuid/users/:userUuid'.
  updateSharedVaultUserPermission: (sharedVaultUuid: string, userUuid: string) =>
    `/v1/shared-vaults/${sharedVaultUuid}/users/${userUuid}`,
  designateSurvivor: (sharedVaultUuid: string, sharedVaultMemberUuid: string) =>
    `/v1/shared-vaults/${sharedVaultUuid}/users/${sharedVaultMemberUuid}/designate-survivor`,
}

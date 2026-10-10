import { SharedVaultUserServerHash } from '@standardnotes/responses'

export type UpdateSharedVaultUserPermissionResponse = {
  /** The membership as it now stands, so a caller need not refetch to learn the result. */
  user: SharedVaultUserServerHash
}

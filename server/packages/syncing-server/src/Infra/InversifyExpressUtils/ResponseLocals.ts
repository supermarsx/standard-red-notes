import { Role } from '@standardnotes/security'

export interface ResponseLocals {
  user: {
    uuid: string
    email: string
  }
  roles: Array<Role>
  isFreeUser: boolean
  session?: {
    uuid: string
    api_version: string
    created_at: string
    updated_at: string
    device_info: string
    readonly_access: boolean
    access_expiration: string
    refresh_expiration: string
  }
  readOnlyAccess: boolean
  mcpScope?: {
    access: 'read' | 'write'
    tagUuids?: string[]
  }
  // Standard Red Notes: per-user gating. Default true when the token omits them.
  collaborationEnabled: boolean
  liveSyncEnabled: boolean
  /**
   * Standard Red Notes: SHADOW-BAN marker read off the cross-service token. When
   * true the user is silently degraded: reduced sync page size + content-transfer
   * allowance (GetItems) and disabled real-time push (SyncItems forces live-sync
   * off). Default false when the token omits it.
   */
  shadowBanned: boolean
  sharedVaultOwnerContext?: {
    upload_bytes_limit: number
  }
  hasContentLimit?: boolean
}

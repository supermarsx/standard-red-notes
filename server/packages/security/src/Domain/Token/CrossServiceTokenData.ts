import { Role } from '../Role/Role'

export type CrossServiceTokenData = {
  version?: number
  user: {
    uuid: string
    email: string
  }
  belongs_to_shared_vaults?: Array<{
    shared_vault_uuid: string
    permission: string
  }>
  shared_vault_owner_context?: {
    upload_bytes_limit: number
  }
  roles: Array<Role>
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
  extensionKey?: string
  hasContentLimit?: boolean
  /**
   * Standard Red Notes: present only on sessions minted by an MCP scoped token.
   * MUST stay optional so existing tokens still validate. `access: 'read'`
   * mirrors `session.readonly_access`; `tagUuids` is enforced client-side by the
   * MCP bridge (the server cannot filter encrypted note content by tag).
   */
  mcp_scope?: {
    access: 'read' | 'write'
    tagUuids?: string[]
  }
}

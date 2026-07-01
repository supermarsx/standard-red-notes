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
  /**
   * Standard Red Notes: per-user gating for collaboration (shared vaults) and
   * live-sync websocket push. OPTIONAL so older tokens still validate; an absent
   * flag MUST be treated as enabled (default-on).
   */
  collaboration_enabled?: boolean
  live_sync_enabled?: boolean
  /**
   * Standard Red Notes: per-user AI assistant gating + metering, read from the
   * auth settings store at token-mint time so the api-gateway can enforce them
   * WITHOUT a second cross-service round trip (mirrors collaboration_enabled).
   *
   * `ai_enabled` is OPT-IN-DISABLE: absent/unset MUST be treated as enabled
   * (default-on); only an explicit disable turns AI off for the user. The
   * api-gateway, however, FAILS CLOSED when an admin has explicitly disabled it.
   *
   * `ai_request_limit` is the per-user daily request cap (>0). Absent/0 means
   * "no per-user override" and the global ASSISTANT_DAILY_REQUEST_LIMIT applies.
   */
  ai_enabled?: boolean
  ai_request_limit?: number
}

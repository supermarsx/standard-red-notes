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
  /**
   * Optional per-user token-window overrides. Absent means inherit the
   * server-wide rolling 5-hour / weekly token limit independently.
   */
  ai_five_hour_token_limit?: number
  ai_weekly_token_limit?: number
  /**
   * Standard Red Notes: per-user WORKFLOWS (n8n automation) gate, read from the
   * auth settings store at token-mint time (SettingName.WorkflowsEnabled).
   *
   * OPT-IN (default-off), the inverse of `ai_enabled`: the field is EMITTED ONLY
   * WHEN the admin-managed setting is literally 'true'. Absent MUST be treated
   * as disabled, which also keeps every pre-existing token valid unchanged.
   */
  workflows_enabled?: boolean
  /**
   * Standard Red Notes: per-user CalDAV gate, read from the auth settings store
   * at token-mint time (SettingName.CaldavEnabled).
   *
   * OPT-IN (default-off), mirroring `workflows_enabled`: the field is EMITTED
   * ONLY WHEN the setting is literally 'true'. Absent MUST be treated as
   * disabled so older tokens fail closed at the API gateway.
   */
  caldav_enabled?: boolean
  /**
   * Standard Red Notes: per-user SERVER-SIDE OCR gate, read from the auth
   * settings store at token-mint time (SettingName.OcrServerAllowed).
   *
   * OPT-IN (default-off), mirroring `workflows_enabled`: the field is EMITTED
   * ONLY WHEN the admin-managed setting is literally 'true'. Absent MUST be
   * treated as NOT allowed — the OcrController FAILS CLOSED because server OCR
   * sends decrypted page images off-device (an E2E downgrade). Keeping it
   * optional also leaves every pre-existing token valid unchanged.
   */
  ocr_server_allowed?: boolean
  /**
   * Standard Red Notes: SHADOW-BAN marker. A shadow-banned user is allowed to
   * sign in and connect normally (unlike a permanent / active-temporary ban,
   * which is rejected before a token is ever minted), but their service is
   * silently DEGRADED downstream (see the syncing-server InversifyExpressAuthMiddleware
   * + GetItems: reduced sync page size, reduced content-transfer allowance and
   * disabled real-time live-sync push).
   *
   * OPT-IN shape, mirroring `workflows_enabled` / `ocr_server_allowed`: the field
   * is EMITTED ONLY WHEN the user is actively shadow-banned. Absent MUST be
   * treated as "not shadow-banned", which also keeps every pre-existing token
   * byte-identical. The user is NEVER told they are shadow-banned (silent).
   */
  shadow_banned?: boolean
}

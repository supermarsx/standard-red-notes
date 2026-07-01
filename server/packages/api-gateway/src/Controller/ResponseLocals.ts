import { Role } from '@standardnotes/security'

export interface ResponseLocals {
  authToken: string
  user: {
    uuid: string
    email: string
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
  readOnlyAccess: boolean
  isFreeUser: boolean
  belongsToSharedVaults?: Array<{
    shared_vault_uuid: string
    permission: string
  }>
  sharedVaultOwnerContext?: {
    upload_bytes_limit: number
  }
  hasContentLimit: boolean
  authTokenVersion?: number
  /**
   * Standard Red Notes: per-user feature settings projected from the cross-service
   * token (e.g. AI_ENABLED / AI_REQUEST_LIMIT / OCR_SERVER_ALLOWED). Populated by
   * AuthMiddleware so feature controllers (AssistantController, OcrController) can
   * enforce per-user gates/limits without a second cross-service round trip.
   */
  settings?: Record<string, unknown>
}

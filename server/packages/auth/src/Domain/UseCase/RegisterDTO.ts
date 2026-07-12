export type RegisterDTO = {
  email: string
  password: string
  updatedWithUserAgent: string
  apiVersion: string
  ephemeralSession: boolean
  pwCost?: number
  pwNonce?: string
  pwSalt?: string
  kpOrigination?: string
  kpCreated?: string
  version?: string
  snjs?: string
  application?: string
  ipAddress?: string | null
  /**
   * Standard Red Notes: optional workspace name for the "multiple accounts per
   * email" feature (WORKSPACES_PER_EMAIL_ENABLED). Ignored entirely when the
   * flag is OFF. When ON, lets the same email register several independent
   * workspaces; an absent/empty value resolves to the 'default' workspace.
   */
  workspaceIdentifier?: string
  /**
   * Standard Red Notes: optional, CLIENT-SUPPLIED per-browser device id used ONLY
   * for the SOFT per-device signup cap. It is trivially forgeable (the client
   * fully controls the value) so it is NOT a security boundary — the cap is a
   * best-effort speed bump enforced ONLY when this is present. Absent on
   * mobile/desktop clients (the per-device cap simply does not apply there).
   */
  deviceId?: string
  /**
   * Standard Red Notes: optional raw signup-invite token (from the `?invite=`
   * URL). When invite-only mode is ON a valid token is REQUIRED (fail-closed);
   * when OFF it is optional but still honored + consumed if present (fail-open).
   * Pulled out of the DTO spread in Register so it is never Object.assign'd onto
   * the persisted User entity.
   */
  inviteToken?: string
}

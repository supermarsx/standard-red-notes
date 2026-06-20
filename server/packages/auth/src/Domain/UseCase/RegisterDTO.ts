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
}

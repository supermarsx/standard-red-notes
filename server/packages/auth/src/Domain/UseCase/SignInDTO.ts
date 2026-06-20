export type SignInDTO = {
  apiVersion: string
  userAgent: string
  email: string
  password: string
  ephemeralSession: boolean
  codeVerifier: string
  hvmToken?: string
  snjs?: string
  application?: string
  ipAddress?: string | null
  /**
   * Standard Red Notes: optional workspace name (WORKSPACES_PER_EMAIL_ENABLED).
   * Ignored when the flag is OFF. When ON, disambiguates which workspace under
   * the given email to sign into; an absent/empty value targets the 'default'
   * workspace.
   */
  workspaceIdentifier?: string
}

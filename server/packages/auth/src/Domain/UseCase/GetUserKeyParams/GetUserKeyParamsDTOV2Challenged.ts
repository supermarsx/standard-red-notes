export type GetUserKeyParamsDTOV2Challenged = {
  authenticated: boolean
  codeChallenge: string
  email?: string
  userUuid?: string
  // Standard Red Notes: optional workspace name (WORKSPACES_PER_EMAIL_ENABLED).
  // Ignored when the flag is OFF.
  workspaceIdentifier?: string
}

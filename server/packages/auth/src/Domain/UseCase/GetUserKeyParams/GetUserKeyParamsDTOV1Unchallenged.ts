export type GetUserKeyParamsDTOV1Unchallenged = {
  authenticated: boolean
  email?: string
  userUuid?: string
  // Standard Red Notes: optional workspace name (WORKSPACES_PER_EMAIL_ENABLED).
  // Ignored when the flag is OFF.
  workspaceIdentifier?: string
}

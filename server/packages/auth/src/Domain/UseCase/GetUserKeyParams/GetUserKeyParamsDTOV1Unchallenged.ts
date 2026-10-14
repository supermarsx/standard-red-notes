export type GetUserKeyParamsDTOV1Unchallenged = {
  authenticated: boolean
  /** Internal snapshot taken before the controller verifies the selected factor. */
  verifiedGrantScope?: string
  email?: string
  userUuid?: string
  // Standard Red Notes: optional workspace name (WORKSPACES_PER_EMAIL_ENABLED).
  // Ignored when the flag is OFF.
  workspaceIdentifier?: string
}

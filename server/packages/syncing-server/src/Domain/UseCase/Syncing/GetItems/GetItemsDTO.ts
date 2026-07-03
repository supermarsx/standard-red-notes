export interface GetItemsDTO {
  userUuid: string
  syncToken?: string | null
  cursorToken?: string | null
  limit?: number
  contentType?: string
  sharedVaultUuids?: string[]
  /**
   * Standard Red Notes: SHADOW-BAN. When true GetItems caps the page size and
   * the content-transfer allowance to the shadow limits (see the constructor),
   * silently reducing how much a shadow-banned user can pull per sync. Optional
   * so existing callers/specs that omit it are treated as not shadow-banned.
   */
  shadowBanned?: boolean
}

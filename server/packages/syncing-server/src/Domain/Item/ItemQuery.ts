export type ItemQuery = {
  userUuid?: string
  sortBy?: string
  sortOrder?: 'ASC' | 'DESC'
  uuids?: Array<string>
  lastSyncTime?: number
  /**
   * Stable keyset-pagination tie breaker. When present, repositories must page
   * lexicographically by (updated_at_timestamp, uuid), not by timestamp alone.
   */
  lastSyncUuid?: string
  syncTimeComparison?: '>' | '>='
  contentType?: string | string[]
  deleted?: boolean
  offset?: number
  limit?: number
  createdBetween?: Date[]
  includeSharedVaultUuids?: string[]
  exclusiveSharedVaultUuids?: string[]
}

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
  /**
   * Standard Red Notes (t99): skip the rows THIS session wrote at or below
   * `excludeUpdatedWithSessionUpToTimestamp`, because the response that issued
   * the caller's position already handed them back as `savedItems`. Both fields
   * are required together and the ceiling is never open-ended: above it, a row
   * written by this same session is a genuinely new write (another tab on the
   * same device shares a session uuid) and must still be delivered.
   *
   * A row with a NULL `updated_with_session` is never skipped. The column is not
   * populated on every topology, and "we cannot tell who wrote this" must
   * resolve to delivering it again, never to withholding it.
   */
  excludeUpdatedWithSession?: string
  excludeUpdatedWithSessionUpToTimestamp?: number
  contentType?: string | string[]
  deleted?: boolean
  offset?: number
  limit?: number
  createdBetween?: Date[]
  includeSharedVaultUuids?: string[]
  exclusiveSharedVaultUuids?: string[]
}

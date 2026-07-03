import { ItemHash } from '../../../Item/ItemHash'

export type SyncItemsDTO = {
  userUuid: string
  itemHashes: Array<ItemHash>
  computeIntegrityHash: boolean
  limit?: number
  sharedVaultUuids?: string[]
  syncToken?: string | null
  cursorToken?: string | null
  contentType?: string
  apiVersion: string
  snjsVersion: string
  readOnlyAccess: boolean
  sessionUuid: string | null
  isFreeUser: boolean
  hasContentLimit: boolean
  // Standard Red Notes: per-user live-sync gating. Default true.
  liveSyncEnabled: boolean
  /**
   * Standard Red Notes: SHADOW-BAN. When true this sync is silently degraded —
   * a reduced page size + content-transfer allowance (threaded into GetItems)
   * and no real-time push (live-sync is forced off for the save). Optional so
   * existing callers/specs that omit it are treated as not shadow-banned.
   */
  shadowBanned?: boolean
}

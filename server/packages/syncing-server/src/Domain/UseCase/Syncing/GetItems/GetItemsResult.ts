import { Item } from '../../../Item/Item'

export interface GetItemsResult {
  items: Item[]
  cursorToken?: string
  lastSyncTime: number | null
  /**
   * Standard Red Notes (t99): the instant captured immediately BEFORE the first
   * read of item rows. Everything this result shows was committed at or before
   * it, so it is the only position a response may honestly claim. The caller
   * clamps the response token to it; without that, the token came from the save
   * half of the sync and silently skipped every row another device committed
   * while this request was still writing.
   */
  retrievalHorizonMicroseconds: number
  /**
   * The digest of the scope the rows were read from — undefined for the
   * account's whole scope, set for a vault-exclusive retrieval. A position
   * measured in a narrower scope must not be replayed as a global one.
   */
  scopeDigest?: string
}

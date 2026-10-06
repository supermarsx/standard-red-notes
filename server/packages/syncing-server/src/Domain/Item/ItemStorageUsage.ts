/**
 * Standard Red Notes: how many BYTES of synced item payload one account is
 * holding on this server, as the three facts a storage figure needs in order to
 * be reported honestly.
 *
 * *** WHY THIS IS NOT JUST A NUMBER. ***
 *
 * `items.content_size` is nullable — it was added by migration (mysql
 * `1637738491169`) over a table that already had rows, and `FixContentSizes`
 * exists precisely because rows can carry none. `SUM()` over a set in which
 * EVERY row is NULL answers NULL, and the pre-existing
 * `sumContentSizeForComputingTransferLimit` coerces that to `0` — which is the
 * right answer for a transfer limit (nothing to charge) and the WRONG one for a
 * storage report, where it claims an account with notes in it is holding nothing.
 *
 * So the measurement is split: the bytes that were actually measured, the number
 * of items they came from, and the number of items that carry no size at all.
 * An account with `unsizedItems > 0` has a total that is a FLOOR rather than a
 * figure, and the reader is told so instead of being handed a flattering number.
 * `sizedItems === 0 && unsizedItems === 0` is the one case in which `0` is a
 * complete, true answer: there is nothing stored.
 */
export type ItemStorageUsage = {
  /**
   * `SUM(content_size)` over this user's non-deleted items that HAVE one, in
   * bytes. Never NULL and never negative: the aggregate's NULL is folded to 0
   * here only because `sizedItems` says whether any row contributed.
   */
  sizedBytes: number
  /** How many non-deleted items carried a content size and are inside `sizedBytes`. */
  sizedItems: number
  /**
   * How many non-deleted items carry NO content size. Every one of them is a
   * byte total nobody measured; none of them is a zero.
   */
  unsizedItems: number
}

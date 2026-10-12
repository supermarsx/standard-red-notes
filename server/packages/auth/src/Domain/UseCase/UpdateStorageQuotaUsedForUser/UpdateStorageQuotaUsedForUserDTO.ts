export interface UpdateStorageQuotaUsedForUserDTO {
  userUuid: string
  /**
   * The byte delta to apply, or — with `absolute` — the authoritative total.
   *
   * A delta is signed: FILE_UPLOADED sends a positive figure and FILE_REMOVED the
   * negative of the bytes that actually left storage, which is what keeps the
   * counter symmetrical across an upload and a delete.
   */
  bytesUsed: number
  /**
   * Standard Red Notes: treat `bytesUsed` as the whole total rather than a delta.
   *
   * *** WHY A RECALCULATION IS A SET AND NOT AN ADD. ***
   *
   * FILE_QUOTA_RECALCULATED carries a total the FILES service summed from the
   * bytes actually on disk for that owner — it is the authority, not an
   * increment. It used to be added, which only produced the right answer because
   * the caller zeroed the counter first, in a separate write. That made the
   * correction a two-step with a visible wrong value in the middle: if the
   * recalculation never arrived — and from the `srn-admin` CLI on a single
   * container it CANNOT, because that boot has no event transport — the account
   * was left reporting a confident `0` while holding megabytes of files. A
   * fabricated zero is worse than an absent figure, because only one of them
   * reads as a measurement.
   */
  absolute?: boolean
  /**
   * Standard Red Notes: the delta is for a file in the account's OWN storage
   * (FILE_UPLOADED / FILE_REMOVED), as opposed to a shared-vault file billed to
   * its owner.
   *
   * It decides one thing: whether a delta that cannot be applied -- no figure is
   * stored, or the books would go below zero -- may be answered by RECOUNTING the
   * account's storage instead. The recount sums the account's own directory and
   * nothing else, so it is the right answer for an own-file delta and the wrong
   * one for a vault file, which lives under the vault and would simply vanish
   * from the owner's total.
   */
  ownFiles?: boolean
}

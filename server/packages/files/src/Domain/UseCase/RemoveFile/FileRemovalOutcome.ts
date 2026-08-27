/**
 * What a successful delete actually did.
 *
 * `already-absent` is still a success — delete is idempotent — but the caller
 * needs to be able to tell the two apart, because only `removed` means bytes
 * left storage and a quota event was published.
 */
export type FileRemovalOutcome = 'removed' | 'already-absent'

/**
 * True when a storage backend failed because the object simply is not there.
 *
 * Delete is the one operation for which "it is already gone" is the goal, not a
 * failure — but neither backend expresses that in its return value, they both
 * throw. `RemoveFile` therefore has to read the throw to tell an absent object
 * apart from a storage outage, and the two must never be conflated: reporting an
 * outage as "already deleted" would invite the caller to drop its only reference
 * to a file that is still stored.
 *
 * Recognised shapes:
 *  - Node fs (`FSFileRemover`): `stat`/`rm` reject with `code === 'ENOENT'`.
 *  - AWS SDK v3 S3 (`S3FileRemover`): `HeadObject` rejects with `NotFound`, and
 *    `GetObject`/`DeleteObject` with `NoSuchKey`. Both also carry
 *    `$metadata.httpStatusCode === 404`, which is checked as a fallback for SDK
 *    versions and S3-compatible servers that do not set the name.
 *
 * Anything else — a permissions error, a timeout, a disk failure — is NOT
 * absence and is deliberately left to propagate.
 */
export function isObjectAbsentError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') {
    return false
  }

  const candidate = error as {
    code?: unknown
    name?: unknown
    $metadata?: { httpStatusCode?: unknown }
  }

  if (candidate.code === 'ENOENT') {
    return true
  }

  if (candidate.name === 'NotFound' || candidate.name === 'NoSuchKey') {
    return true
  }

  return candidate.$metadata?.httpStatusCode === 404
}

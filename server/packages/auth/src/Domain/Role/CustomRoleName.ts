/**
 * Standard Red Notes: normalize an admin-entered custom role name to a canonical
 * SCREAMING_SNAKE_CASE identifier (e.g. "Support Agent" -> "SUPPORT_AGENT").
 * Keeps letters and digits, collapses every other run into a single underscore,
 * and trims leading/trailing underscores. Returns null when nothing usable
 * remains (empty / punctuation-only input).
 *
 * Shared by CreateCustomRole (server) so the persisted name is deterministic and
 * safe to compare against the built-in RoleName enum.
 */
export const normalizeCustomRoleName = (raw: string | null | undefined): string | null => {
  if (typeof raw !== 'string') {
    return null
  }

  const normalized = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+/, '')
    .replace(/_+$/, '')

  return normalized.length === 0 ? null : normalized
}

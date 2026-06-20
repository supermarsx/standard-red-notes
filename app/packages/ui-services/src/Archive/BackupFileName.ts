import { createZippableFileName } from '@standardnotes/utils'

const MaxTitleLength = 100

/**
 * Formats a Date as `YYYY-MM-DDTHH.mm.ss` (the format requested in the upstream
 * forum issue). We use `.` instead of `:` because `:` is illegal in Windows file
 * names, and we format manually (with zero-padding) so the result is deterministic
 * and locale-independent — the same item always yields the same backup file name.
 */
export function formatBackupTimestamp(date: Date): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return 'unknown-date'
  }

  const pad = (value: number, length = 2): string => String(value).padStart(length, '0')

  const year = pad(date.getFullYear(), 4)
  const month = pad(date.getMonth() + 1)
  const day = pad(date.getDate())
  const hours = pad(date.getHours())
  const minutes = pad(date.getMinutes())
  const seconds = pad(date.getSeconds())

  return `${year}-${month}-${day}T${hours}.${minutes}.${seconds}`
}

/**
 * Sanitizes a note title into a Windows-safe file-name fragment:
 * - strips ASCII control characters (0x00-0x1F)
 * - replaces characters illegal on Windows (`\ / : * ? " < > |`) with `_`
 * - collapses runs of whitespace into a single space
 * - removes trailing dots/spaces (illegal/awkward on Windows)
 * - falls back to "Untitled" when nothing usable remains
 */
export function sanitizeBackupTitle(title: string): string {
  const cleaned = (title ?? '')
    // collapse all whitespace (incl. tabs/newlines) to a single space FIRST, so the
    // control-char strip below doesn't silently glue words together.
    .replace(/\s+/g, ' ')
    // strip remaining ASCII control characters (0x00-0x1F). The RegExp is built from
    // char codes so no raw control bytes are embedded in this source file.
    .replace(new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}]`, 'g'), '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    // strip trailing dots/spaces (Windows trims/forbids them on real files)
    .replace(/[. ]+$/, '')
    .trim()

  return cleaned.length > 0 ? cleaned : 'Untitled'
}

/**
 * Builds a human-readable, filesystem-safe file name for a single backup entry.
 *
 * The reported bug was that automatic/plaintext backup files were named after the
 * item's opaque uuid ("gibberish"). Here we instead prefer the note title, fall
 * back to "Untitled" when it is empty, sanitize characters that are illegal on
 * Windows, and append the item's own timestamp in `YYYY-MM-DDTHH.mm.ss` form so a
 * folder of backups is browsable and two notes that share a title don't collide.
 *
 * @param title     the note title (may be empty/whitespace)
 * @param timestamp the item's own `created_at`/`updated_at` Date (NOT Date.now())
 * @param extension the file extension to keep (e.g. 'txt', 'json', 'md')
 */
export function createBackupFileName(title: string, timestamp: Date, extension: string): string {
  const baseName = sanitizeBackupTitle(title)
  const suffix = ` - ${formatBackupTimestamp(timestamp)}`

  // createZippableFileName additionally truncates the base to a sane length and
  // appends the suffix + extension. The base is already sanitized above; the
  // second pass through sanitizeFileName is harmless (idempotent on safe input).
  return createZippableFileName(baseName, suffix, extension, MaxTitleLength)
}

import { FileItem } from '@standardnotes/snjs'

/** The field a file card / files list sorts by. */
export type FilesSortBy = 'name' | 'size' | 'date'
export type FilesSortDirection = 'asc' | 'dsc'

/**
 * Standard Red Notes: the single shared, pure sort used by both the full-column
 * FilesView gallery and any other files listing. Extracted so the gallery and the
 * controller share ONE implementation rather than each maintaining its own (which
 * could silently drift).
 *
 * Returns a NEW array (never mutates the input). The comparison is STABLE for equal
 * keys: ties fall through to a 0 comparison, and Array.prototype.sort is stable in
 * all supported engines, so equal-key items keep their original relative order.
 */
export const sortFiles = (
  files: FileItem[],
  sortBy: FilesSortBy,
  direction: FilesSortDirection,
): FileItem[] => {
  const factor = direction === 'asc' ? 1 : -1
  return [...files].sort((a, b) => {
    let comparison = 0
    if (sortBy === 'name') {
      comparison = (a.name ?? '').localeCompare(b.name ?? '')
    } else if (sortBy === 'size') {
      comparison = a.decryptedSize - b.decryptedSize
    } else {
      comparison = a.created_at.getTime() - b.created_at.getTime()
    }
    return comparison * factor
  })
}

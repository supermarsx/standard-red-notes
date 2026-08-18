import { SortableItem } from '@standardnotes/snjs'
import { FilesSortBy } from '@/Utils/Items/sortFiles'

/**
 * The shared Table speaks in SortableItem keys while FilesView deliberately keeps
 * its smaller, controller-persisted name/size/date contract. These mappings keep
 * the table header and the existing toolbar on the same source of truth.
 */
const tableSortByByFilesSortBy: Record<FilesSortBy, keyof SortableItem> = {
  name: 'title',
  size: 'decryptedSize',
  date: 'created_at',
}

export const tableSortByForFilesSortBy = (sortBy: FilesSortBy): keyof SortableItem => tableSortByByFilesSortBy[sortBy]

export const filesSortByForTableSortBy = (sortBy: keyof SortableItem): FilesSortBy | undefined => {
  const entry = Object.entries(tableSortByByFilesSortBy).find(([, tableSortBy]) => tableSortBy === sortBy)
  return entry?.[0] as FilesSortBy | undefined
}

export const getFileTypeLabel = ({ name, mimeType }: { name: string; mimeType: string }): string => {
  const normalizedMimeType = mimeType.trim()
  if (normalizedMimeType) {
    return normalizedMimeType
  }

  const extensionSeparator = name.lastIndexOf('.')
  const extension = extensionSeparator > 0 ? name.slice(extensionSeparator + 1).trim() : ''
  return extension ? `${extension.toUpperCase()} file` : 'Unknown type'
}

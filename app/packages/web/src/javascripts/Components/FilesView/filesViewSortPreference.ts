import { PrefKey, SortableItem, SystemViewId } from '@standardnotes/snjs'
import type { WebApplication } from '@/Application/WebApplication'
import { FilesSortBy } from '@/Utils/Items/sortFiles'
import { filesSortByForTableSortBy, tableSortByForFilesSortBy } from './FilesViewTableUtils'

export type FilesSortDirection = 'asc' | 'dsc'

export type PersistedFilesSort = {
  sortBy: FilesSortBy
  sortDirection: FilesSortDirection
}

/**
 * Standard Red Notes: the Files sort preference.
 *
 * The Files smart view persisted its sort under
 * `SystemViewPreferences[SystemViewId.Files]` while the Files tab kept sort in
 * memory on ItemListController, so consolidating onto the tab would have left a
 * saved preference orphaned and silently reset every user's sort. The tab reads
 * and writes that same key instead, which makes the existing value the live one
 * and removes the need for a migration.
 *
 * The `sortReverse` flag needs care: the two surfaces read it oppositely.
 * ContentTableView derived `sortReversed = sortDirection === 'asc'` (SNJS's
 * convention, where reversing flips the default descending order), whereas the
 * tab's table uses `sortReversed = sortDirection === 'dsc'`. The stored value is
 * interpreted here the way the smart view wrote it -- `sortReverse: true` means
 * ascending -- so a preference saved before the merge still means what the user
 * chose.
 */
const systemViewPreferences = (application: WebApplication): Record<string, unknown> =>
  (application.getPreference(PrefKey.SystemViewPreferences) as Record<string, unknown> | undefined) || {}

export const readPersistedFilesSort = (application: WebApplication): PersistedFilesSort | undefined => {
  const stored = systemViewPreferences(application)[SystemViewId.Files] as
    | { sortBy?: string; sortReverse?: boolean }
    | undefined

  if (!stored?.sortBy) {
    return undefined
  }

  const sortBy = filesSortByForTableSortBy(stored.sortBy as keyof SortableItem)
  if (!sortBy) {
    // A sort the tab has no column for (e.g. the list-only Custom order).
    return undefined
  }

  return { sortBy, sortDirection: stored.sortReverse ? 'asc' : 'dsc' }
}

export const writePersistedFilesSort = async (
  application: WebApplication,
  { sortBy, sortDirection }: PersistedFilesSort,
): Promise<void> => {
  const existing = systemViewPreferences(application)
  const filesPreferences = (existing[SystemViewId.Files] as Record<string, unknown> | undefined) || {}

  await application.setPreference(PrefKey.SystemViewPreferences, {
    ...existing,
    [SystemViewId.Files]: {
      ...filesPreferences,
      sortBy: tableSortByForFilesSortBy(sortBy),
      sortReverse: sortDirection === 'asc',
    },
  } as never)
}

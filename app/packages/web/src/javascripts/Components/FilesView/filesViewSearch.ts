import { FileItem } from '@standardnotes/snjs'
import { getFileTypeLabel } from './FilesViewTableUtils'

/**
 * Standard Red Notes: the Files tab's search.
 *
 * The Files smart view got search for free from the navigation-scoped item list
 * (SearchBar drives ItemListController's display options). The tab deliberately
 * lists `items.getDisplayableFiles()` independently of the sidebar selection, so
 * it cannot reuse that pipeline without reintroducing the coupling the tab
 * exists to avoid -- hence this small local matcher over the columns the tab
 * actually shows: name, description and type.
 *
 * Matching is case-insensitive and AND-combines whitespace-separated terms, so
 * "report pdf" finds a PDF named "report" rather than everything that is either.
 */
export const fileMatchesQuery = (file: FileItem, query: string): boolean => {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)

  if (terms.length === 0) {
    return true
  }

  const haystack = [file.name, file.description || '', getFileTypeLabel(file)].join(' ').toLowerCase()

  return terms.every((term) => haystack.includes(term))
}

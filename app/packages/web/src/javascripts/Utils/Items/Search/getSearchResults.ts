import { naturalSort, ContentType, FolderContentType } from '@standardnotes/snjs'
import { createLinkFromItem } from './createLinkFromItem'
import { doesItemMatchSearchQuery } from './doesItemMatchSearchQuery'
import { isSearchResultAlreadyLinkedToItem } from './isSearchResultAlreadyLinkedToItem'
import { isSearchResultExistingTag } from './isSearchResultExistingTag'
import { ItemLink } from './ItemLink'
import { LinkableItem } from './LinkableItem'
import { WebApplicationInterface } from '@standardnotes/ui-services'

const MaxLinkedResults = 50

function resultLimitForSearchQuery(query: string): number {
  const limitPerContentType = 10
  return Math.max(limitPerContentType, query.length * 3)
}

export function getLinkingSearchResults(
  searchQuery: string,
  application: WebApplicationInterface,
  activeItem?: LinkableItem,
  options: {
    contentType?: string
    returnEmptyIfQueryEmpty?: boolean
    /**
     * Offer folders alongside tags/notes/files. Opt-in, because the other consumers of
     * this function embed whatever is picked into the note body (the SuperEditor
     * `@`-mention plugin dispatches INSERT_BUBBLE_COMMAND) and a folder is a location,
     * not something to embed.
     */
    includeFolders?: boolean
  } = { returnEmptyIfQueryEmpty: true },
): {
  linkedResults: ItemLink<LinkableItem>[]
  linkedItems: LinkableItem[]
  unlinkedItems: LinkableItem[]
  shouldShowCreateTag: boolean
} {
  let unlinkedItems: LinkableItem[] = []
  const linkedItems: LinkableItem[] = []
  const linkedResults: ItemLink<LinkableItem>[] = []
  let shouldShowCreateTag = false

  const defaultReturnValue = {
    linkedResults,
    unlinkedItems,
    linkedItems,
    shouldShowCreateTag,
  }

  if (!activeItem) {
    return defaultReturnValue
  }

  if (!searchQuery.length && options.returnEmptyIfQueryEmpty) {
    return defaultReturnValue
  }

  const searchableContentTypes = [ContentType.TYPES.Note, ContentType.TYPES.File, ContentType.TYPES.Tag]

  if (options.includeFolders) {
    searchableContentTypes.push(FolderContentType)
  }

  const searchableItems = naturalSort(application.items.getItems(searchableContentTypes), 'title')

  const unlinkedFolders: LinkableItem[] = []
  const unlinkedTags: LinkableItem[] = []
  const unlinkedNotes: LinkableItem[] = []
  const unlinkedFiles: LinkableItem[] = []

  for (let index = 0; index < searchableItems.length; index++) {
    const item = searchableItems[index]

    if (activeItem.uuid === item.uuid) {
      continue
    }

    if (options.contentType && item.content_type !== options.contentType) {
      continue
    }

    if (searchQuery.length && !doesItemMatchSearchQuery(item, searchQuery, application)) {
      continue
    }

    if (isSearchResultAlreadyLinkedToItem(item, activeItem)) {
      if (linkedResults.length < MaxLinkedResults) {
        linkedResults.push(createLinkFromItem(item, 'linked'))
      }
      linkedItems.push(item)
      continue
    }

    const enforceResultLimit = options.contentType == null

    const limitPerContentType = resultLimitForSearchQuery(searchQuery)

    if (
      item.content_type === FolderContentType &&
      (!enforceResultLimit || unlinkedFolders.length < limitPerContentType)
    ) {
      unlinkedFolders.push(item)
      continue
    }

    if (
      item.content_type === ContentType.TYPES.Tag &&
      (!enforceResultLimit ||
        (unlinkedTags.length < limitPerContentType && item.content_type === ContentType.TYPES.Tag))
    ) {
      unlinkedTags.push(item)
      continue
    }

    if (
      item.content_type === ContentType.TYPES.Note &&
      (!enforceResultLimit || unlinkedNotes.length < limitPerContentType)
    ) {
      unlinkedNotes.push(item)
      continue
    }

    if (
      item.content_type === ContentType.TYPES.File &&
      (!enforceResultLimit || unlinkedFiles.length < limitPerContentType)
    ) {
      unlinkedFiles.push(item)
      continue
    }
  }

  // Folders lead: filing a note is the most decisive of these actions, and there is at
  // most one folder result the user can act on per note.
  unlinkedItems = [...unlinkedFolders, ...unlinkedTags, ...unlinkedNotes, ...unlinkedFiles]

  shouldShowCreateTag =
    !linkedResults.find((link) => isSearchResultExistingTag(link.item, searchQuery)) &&
    !unlinkedItems.find((item) => isSearchResultExistingTag(item, searchQuery))

  return {
    linkedResults,
    linkedItems,
    unlinkedItems,
    shouldShowCreateTag,
  }
}

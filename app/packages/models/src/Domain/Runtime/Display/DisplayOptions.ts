import { SmartView } from '../../Syncable/SmartView'
import { SNTag } from '../../Syncable/Tag'
import { SNFolder } from '../../Syncable/Folder'
import { CollectionSortDirection, CollectionSortProperty } from '../Collection/CollectionSort'
import { SearchQuery } from './Search/Types'
import { DisplayControllerCustomFilter } from './Types'

export interface GenericDisplayOptions {
  includePinned?: boolean
  includeProtected?: boolean
  includeTrashed?: boolean
  includeArchived?: boolean
}

export interface NotesAndFilesDisplayOptions extends GenericDisplayOptions {
  tags?: SNTag[]
  folders?: SNFolder[]
  views?: SmartView[]
  searchQuery?: SearchQuery
  hiddenContentTypes?: string[]
  customFilter?: DisplayControllerCustomFilter
}

export interface TagsAndViewsDisplayOptions extends GenericDisplayOptions {
  searchQuery?: SearchQuery
  customFilter?: DisplayControllerCustomFilter
}

export interface DisplayControllerDisplayOptions extends GenericDisplayOptions {
  sortBy: CollectionSortProperty
  sortDirection: CollectionSortDirection
  /**
   * Standard Red Notes: explicit user-defined order of item uuids, consulted
   * only when sortBy is the Custom sentinel. Items not present fall back to a
   * stable secondary sort and are appended at the end.
   */
  customOrder?: string[]
}

export type NotesAndFilesDisplayControllerOptions = NotesAndFilesDisplayOptions & DisplayControllerDisplayOptions
export type TagsDisplayControllerOptions = TagsAndViewsDisplayOptions & DisplayControllerDisplayOptions
export type AnyDisplayOptions = NotesAndFilesDisplayOptions | TagsAndViewsDisplayOptions | GenericDisplayOptions

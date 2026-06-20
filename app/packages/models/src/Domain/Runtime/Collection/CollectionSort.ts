export interface SortableItem {
  uuid: string
  content_type: string
  created_at: Date
  userModifiedDate: Date
  title?: string
  pinned: boolean
  decryptedSize?: number
}

/**
 * Standard Red Notes: sentinel sort "property" denoting a user-defined manual
 * ordering. Unlike the other CollectionSort values it is NOT a key of
 * SortableItem; when it is the active sortBy, ordering is driven by an explicit
 * array of item uuids (the customOrder display option) rather than an item field.
 */
export const CustomSortKey = 'custom'

export const CollectionSort = {
  CreatedAt: 'created_at',
  UpdatedAt: 'userModifiedDate',
  Title: 'title',
  Custom: CustomSortKey,
} as const

export type CollectionSortDirection = 'asc' | 'dsc'

export type CollectionSortProperty = keyof SortableItem | typeof CustomSortKey

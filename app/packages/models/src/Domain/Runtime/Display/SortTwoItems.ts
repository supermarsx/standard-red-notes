import { isString } from '@standardnotes/utils'
import {
  CollectionSort,
  CollectionSortDirection,
  CollectionSortProperty,
  CustomSortKey,
} from '../Collection/CollectionSort'
import { DisplayItem } from './Types'

export const SortLeftFirst = -1
export const SortRightFirst = 1
export const KeepSameOrder = 0

/**
 * Standard Red Notes: compare two items by an explicit user-defined order.
 *
 * `orderMap` maps an item uuid to its index in the persisted custom order.
 * Items present in the map sort by ascending index. Items absent from the map
 * (e.g. newly created since the order was last saved) are appended after all
 * ordered items, and tie-break among themselves by a stable secondary sort
 * (title, then created_at) so their position is deterministic.
 */
export function sortByCustomOrder(
  a: DisplayItem,
  b: DisplayItem,
  orderMap: Record<string, number>,
): number {
  const aIndex = orderMap[a.uuid]
  const bIndex = orderMap[b.uuid]
  const aHas = aIndex !== undefined
  const bHas = bIndex !== undefined

  if (aHas && bHas) {
    if (aIndex === bIndex) {
      return KeepSameOrder
    }
    return aIndex < bIndex ? SortLeftFirst : SortRightFirst
  }

  /** Ordered items always come before unordered (new) items. */
  if (aHas) {
    return SortLeftFirst
  }
  if (bHas) {
    return SortRightFirst
  }

  /** Neither is in the custom order: stable secondary sort by title then created. */
  const aTitle = a.title || ''
  const bTitle = b.title || ''
  if (aTitle.length > 0 && bTitle.length > 0) {
    const titleCompare = aTitle.localeCompare(bTitle, 'en', { numeric: true })
    if (titleCompare !== 0) {
      return titleCompare < 0 ? SortLeftFirst : SortRightFirst
    }
  }
  if (a.created_at > b.created_at) {
    return SortRightFirst
  }
  if (a.created_at < b.created_at) {
    return SortLeftFirst
  }
  return KeepSameOrder
}

/** @O(n * log(n)) */
export function sortTwoItems(
  a: DisplayItem | undefined,
  b: DisplayItem | undefined,
  sortBy: CollectionSortProperty,
  sortDirection: CollectionSortDirection,
  bypassPinCheck = false,
  customOrderMap?: Record<string, number>,
): number {
  /** If the elements are undefined, move to beginning */
  if (!a) {
    return SortLeftFirst
  }

  if (!b) {
    return SortRightFirst
  }

  if (!bypassPinCheck) {
    if (a.pinned && b.pinned) {
      return sortTwoItems(a, b, sortBy, sortDirection, true, customOrderMap)
    }
    if (a.pinned) {
      return SortLeftFirst
    }
    if (b.pinned) {
      return SortRightFirst
    }
  }

  /**
   * Standard Red Notes: manual ordering. When the active sort is Custom and an
   * order map is provided, position is determined by the explicit uuid order
   * rather than by an item field. (Pinned items still float to the top above.)
   */
  if (sortBy === CustomSortKey && customOrderMap) {
    return sortByCustomOrder(a, b, customOrderMap)
  }

  const aValue = a[sortBy as keyof DisplayItem] || ''
  const bValue = b[sortBy as keyof DisplayItem] || ''
  const smallerNaturallyComesFirst = sortDirection === 'asc'

  let compareResult = KeepSameOrder

  /**
   * Check for string length due to issue on React Native 0.65.1
   * where empty strings causes crash:
   * https://github.com/facebook/react-native/issues/32174
   * */
  if (
    sortBy === CollectionSort.Title &&
    isString(aValue) &&
    isString(bValue) &&
    aValue.length > 0 &&
    bValue.length > 0
  ) {
    compareResult = aValue.localeCompare(bValue, 'en', { numeric: true })
  } else if (aValue > bValue) {
    compareResult = SortRightFirst
  } else if (aValue < bValue) {
    compareResult = SortLeftFirst
  } else {
    compareResult = KeepSameOrder
  }

  const isLeftSmaller = compareResult === SortLeftFirst
  const isLeftBigger = compareResult === SortRightFirst

  if (isLeftSmaller) {
    if (smallerNaturallyComesFirst) {
      return SortLeftFirst
    } else {
      return SortRightFirst
    }
  } else if (isLeftBigger) {
    if (smallerNaturallyComesFirst) {
      return SortRightFirst
    } else {
      return SortLeftFirst
    }
  } else {
    return KeepSameOrder
  }
}

import { DecryptedItemInterface } from '@standardnotes/snjs'

/**
 * Pure helper that, given a set of items and a target item, returns the items that
 * reference (link to) the target — i.e. the target's backlinks.
 *
 * Note: the live app computes backlinks via the indexed `items.itemsReferencingItem`
 * lookup for performance (see LinkingController). This helper exists primarily as an
 * isolatable, testable description of the same relationship and can be used as a
 * fallback when an index is not available.
 */
export function findItemsReferencingItem<I extends DecryptedItemInterface = DecryptedItemInterface>(
  allItems: I[],
  target: { uuid: string },
): I[] {
  if (!target?.uuid) {
    return []
  }

  return allItems.filter((item) => {
    if (item.uuid === target.uuid) {
      return false
    }

    return item.references.some((reference) => reference.uuid === target.uuid)
  })
}

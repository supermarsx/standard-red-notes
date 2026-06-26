import { compareValues } from '@standardnotes/utils'
import { isDeletedItem, isEncryptedItem } from '../../Abstract/Item'
import { ItemDelta } from '../Index/ItemDelta'
import { AnyDisplayOptions, DisplayControllerDisplayOptions, GenericDisplayOptions } from './DisplayOptions'
import { sortTwoItems } from './SortTwoItems'
import { CustomSortKey } from '../Collection/CollectionSort'
import { UuidToSortedPositionMap, DisplayItem, ReadonlyItemCollection } from './Types'
import { CriteriaValidatorInterface } from './Validator/CriteriaValidatorInterface'
import { CollectionCriteriaValidator } from './Validator/CollectionCriteriaValidator'
import { CustomFilterCriteriaValidator } from './Validator/CustomFilterCriteriaValidator'
import { ExcludeVaultsCriteriaValidator } from './Validator/ExcludeVaultsCriteriaValidator'
import { ExclusiveVaultCriteriaValidator } from './Validator/ExclusiveVaultCriteriaValidator'
import { HiddenContentCriteriaValidator } from './Validator/HiddenContentCriteriaValidator'
import { VaultDisplayOptions } from './VaultDisplayOptions'
import { isExclusionaryOptionsValue } from './VaultDisplayOptionsTypes'

export class ItemDisplayController<I extends DisplayItem, O extends AnyDisplayOptions = GenericDisplayOptions> {
  private sortMap: UuidToSortedPositionMap = {}
  private sortedItems: I[] = []
  private needsSort = true

  /**
   * Standard Red Notes: a monotonic counter bumped whenever {@link sortedItems}
   * is mutated (this controller is the sole mutator). Lets callers memoize
   * derived views — e.g. `ItemManager.getDisplayableNotes`'s `filter(isNote)` —
   * keyed on this version, since `items()` returns the live array (which can be
   * mutated in place without changing its reference) so reference identity is
   * not a sound invalidation signal.
   */
  private changeVersion = 0

  public get version(): number {
    return this.changeVersion
  }

  constructor(
    private readonly collection: ReadonlyItemCollection,
    public readonly contentTypes: string[],
    private options: DisplayControllerDisplayOptions & O,
    private vaultOptions?: VaultDisplayOptions,
  ) {
    this.filterThenSortElements(this.collection.all(this.contentTypes) as I[])
  }

  public items(): I[] {
    /**
     * Standard Red Notes (cold-load O(n^2) fix): sorting can be DEFERRED during the
     * initial bulk database load (see {@link onCollectionChange}'s `deferSort`). In that
     * mode each batch only does the cheap filter/insert bookkeeping and leaves
     * {@link needsSort} set, skipping the per-batch O(n) resort that made cold-load
     * O(n^2). The sort is then performed lazily here, on first read, so any caller that
     * observes `items()` mid-load (or at load-end) always sees a fully sorted array.
     * This makes deferral transparent: the FINAL order is byte-identical to sorting on
     * every batch (a single O(n log n) sort over the same set yields the same result).
     */
    if (this.needsSort) {
      this.needsSort = false
      this.resortItems()
    }
    return this.sortedItems
  }

  public hasExclusiveVaultOptions(): boolean {
    return this.vaultOptions ? !isExclusionaryOptionsValue(this.vaultOptions.getOptions()) : false
  }

  public getDisplayOptions(): DisplayControllerDisplayOptions & O {
    return this.options
  }

  setVaultDisplayOptions(vaultOptions?: VaultDisplayOptions): void {
    this.vaultOptions = vaultOptions
    this.needsSort = true

    this.filterThenSortElements(this.collection.all(this.contentTypes) as I[])
  }

  setDisplayOptions(displayOptions: Partial<DisplayControllerDisplayOptions & O>): void {
    this.options = { ...this.options, ...displayOptions }
    this.needsSort = true

    this.filterThenSortElements(this.collection.all(this.contentTypes) as I[])
  }

  /**
   * @param deferSort Standard Red Notes (cold-load O(n^2) fix): when true (set only
   * during the INITIAL bulk database load), skip the per-batch resort. The cheap
   * filter/insert bookkeeping still runs, but the expensive O(n) sort is deferred and
   * performed once, lazily, on the next {@link items} read. Sorting on every one of N
   * load batches is O(n^2); deferring collapses it to a single O(n log n) sort with an
   * identical final order.
   */
  onCollectionChange(delta: ItemDelta, deferSort = false): void {
    const items = [...delta.changed, ...delta.inserted, ...delta.discarded].filter((i) =>
      this.contentTypes.includes(i.content_type),
    )
    this.filterThenSortElements(items as I[], deferSort)
  }

  private passesAllFilters(element: I): boolean {
    const filters: CriteriaValidatorInterface[] = [new CollectionCriteriaValidator(this.collection, element)]

    if (this.vaultOptions) {
      const options = this.vaultOptions.getOptions()
      if (isExclusionaryOptionsValue(options)) {
        filters.push(new ExcludeVaultsCriteriaValidator([...options.exclude, ...options.locked], element))
      } else {
        filters.push(new ExclusiveVaultCriteriaValidator(options.exclusive, element))
      }
    }

    if ('hiddenContentTypes' in this.options && this.options.hiddenContentTypes) {
      filters.push(new HiddenContentCriteriaValidator(this.options.hiddenContentTypes, element))
    }

    if ('customFilter' in this.options && this.options.customFilter) {
      filters.push(new CustomFilterCriteriaValidator(this.options.customFilter, element))
    }

    return filters.every((f) => f.passes())
  }

  private filterThenSortElements(elements: I[], deferSort = false): void {
    if (elements.length > 0) {
      this.changeVersion++
    }

    for (const element of elements) {
      const previousIndex = this.sortMap[element.uuid]
      const previousElement = previousIndex != undefined ? this.sortedItems[previousIndex] : undefined

      const remove = () => {
        if (previousIndex != undefined) {
          delete this.sortMap[element.uuid]

          /** We don't yet remove the element directly from the array, since mutating
           * the array inside a loop could render all other upcoming indexes invalid */
          ;(this.sortedItems[previousIndex] as unknown) = undefined

          /** Since an element is being removed from the array, we need to recompute
           * the new positions for elements that are staying */
          this.needsSort = true
        }
      }

      if (isDeletedItem(element) || isEncryptedItem(element)) {
        remove()
        continue
      }

      const passes = this.passesAllFilters(element)

      if (passes) {
        if (previousElement != undefined) {
          /** Check to see if the element has changed its sort value. If so, we need to re-sort.
           * In Custom (manual) sort mode there is no per-item sort field; ordering changes only
           * when the customOrder option itself changes (handled via setDisplayOptions). */
          const sortKey = this.options.sortBy === CustomSortKey ? undefined : (this.options.sortBy as keyof I)
          const previousValue = sortKey ? previousElement[sortKey] : undefined

          const newValue = sortKey ? element[sortKey] : undefined

          /** Replace the current element with the new one. */
          this.sortedItems[previousIndex] = element

          /** If the pinned status of the element has changed, it needs to be resorted */
          const pinChanged = previousElement.pinned !== element.pinned

          if (!compareValues(previousValue, newValue) || pinChanged) {
            /** Needs resort because its re-sort value has changed,
             * and thus its position might change */
            this.needsSort = true
          }
        } else {
          /** Has not yet been inserted */
          this.sortedItems.push(element)

          /**
           * Standard Red Notes (cold-load fix): record a PROVISIONAL position for this
           * uuid immediately. Normally `sortMap` is only repopulated inside
           * `resortItems`, but when sorting is deferred across many batches that resort
           * doesn't run between batches — so a later batch re-emitting the same uuid
           * would not find `previousIndex` and would push a DUPLICATE. Tracking the
           * just-pushed index here makes the re-emit take the "replace in place" branch
           * instead. (A later `resortItems` overwrites this with the true sorted index;
           * any stale provisional index for a removed slot is harmless because the slot
           * is set to undefined and compacted out during resort.)
           */
          this.sortMap[element.uuid] = this.sortedItems.length - 1

          /** Needs re-sort because we're just pushing the element to the end here */
          this.needsSort = true
        }
      } else {
        /** Doesn't pass filter, remove from sorted and filtered */
        remove()
      }
    }

    /**
     * Standard Red Notes (cold-load O(n^2) fix): when `deferSort` is set (initial bulk
     * load only) we intentionally LEAVE `needsSort` true and skip the resort. The array
     * holds the new elements (appended, possibly with undefined holes from removals) and
     * is sorted lazily on the next `items()` read. Outside the bulk-load window this is
     * unchanged: we resort immediately so reads are always sorted.
     */
    if (this.needsSort && !deferSort) {
      this.needsSort = false
      this.resortItems()
    }
  }

  /** Resort the sortedItems array, and update the saved positions */
  private resortItems() {
    /**
     * Standard Red Notes: when a custom (manual) order is active, precompute a
     * uuid -> index map once per sort so the comparator is O(1) per comparison.
     */
    let customOrderMap: Record<string, number> | undefined
    if (this.options.sortBy === CustomSortKey && this.options.customOrder) {
      customOrderMap = {}
      this.options.customOrder.forEach((uuid, index) => {
        ;(customOrderMap as Record<string, number>)[uuid] = index
      })
    }

    const resorted = this.sortedItems.sort((a, b) => {
      return sortTwoItems(a, b, this.options.sortBy, this.options.sortDirection, false, customOrderMap)
    })

    /**
     * Now that resorted contains the sorted elements (but also can contain undefined element)
     * we create another array that filters out any of the undefinedes. We also keep track of the
     * current index while we loop and set that in the this.sortMap.
     * */
    const results = []
    let currentIndex = 0

    /** @O(n) */
    for (const element of resorted) {
      if (!element) {
        continue
      }

      results.push(element)

      this.sortMap[element.uuid] = currentIndex

      currentIndex++
    }

    this.sortedItems = results
  }
}

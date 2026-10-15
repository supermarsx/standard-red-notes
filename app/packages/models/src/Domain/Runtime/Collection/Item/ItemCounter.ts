import { removeFromArray } from '@standardnotes/utils'
import { isTag, SNTag } from '../../../Syncable/Tag/Tag'
import { SNIndex } from '../../Index/SNIndex'
import { ItemCollection } from './ItemCollection'
import { ItemDelta } from '../../Index/ItemDelta'
import { DecryptedItemInterface, isDecryptedItem, ItemInterface } from '../../../Abstract/Item'
import { CriteriaValidatorInterface } from '../../Display/Validator/CriteriaValidatorInterface'
import { CollectionCriteriaValidator } from '../../Display/Validator/CollectionCriteriaValidator'
import { ExcludeVaultsCriteriaValidator } from '../../Display/Validator/ExcludeVaultsCriteriaValidator'
import { ExclusiveVaultCriteriaValidator } from '../../Display/Validator/ExclusiveVaultCriteriaValidator'
import { HiddenContentCriteriaValidator } from '../../Display/Validator/HiddenContentCriteriaValidator'
import { CustomFilterCriteriaValidator } from '../../Display/Validator/CustomFilterCriteriaValidator'
import { AnyDisplayOptions, VaultDisplayOptions } from '../../Display'
import { isExclusionaryOptionsValue } from '../../Display/VaultDisplayOptionsTypes'
import { ContentType } from '@standardnotes/domain-core'
import { SNFolder, isFolderItem, FolderContentType } from '../../../Syncable/Folder'

type AllNotesUuidSignifier = undefined
export type TagItemCountChangeObserver = (tagUuid: string | AllNotesUuidSignifier) => void

export class ItemCounter implements SNIndex {
  private tagToItemsMap: Partial<Record<string, Set<string>>> = {}
  private tagsByCountedItem = new Map<string, Set<string>>()
  private folderParents = new Map<string, string | undefined>()
  private folderChildren = new Map<string, Set<string>>()
  private allCountableItems = new Set<string>()
  private countableItemsByType = new Map<string, Set<string>>()
  private displayOptions?: AnyDisplayOptions
  private vaultDisplayOptions?: VaultDisplayOptions

  constructor(
    private collection: ItemCollection,
    public observers: TagItemCountChangeObserver[] = [],
  ) {}

  public addCountChangeObserver(observer: TagItemCountChangeObserver): () => void {
    this.observers.push(observer)

    const thislessEventObservers = this.observers
    return () => {
      removeFromArray(thislessEventObservers, observer)
    }
  }

  public setDisplayOptions(options: AnyDisplayOptions) {
    this.displayOptions = options
    this.receiveItemChanges(this.collection.all())
  }

  public setVaultDisplayOptions(options: VaultDisplayOptions) {
    this.vaultDisplayOptions = options
    this.receiveItemChanges(this.collection.all())
  }

  public allCountableItemsCount(): number {
    return this.allCountableItems.size
  }

  public allCountableNotesCount(): number {
    return this.countableItemsByType.get(ContentType.TYPES.Note)?.size || 0
  }

  public allCountableFilesCount(): number {
    return this.countableItemsByType.get(ContentType.TYPES.File)?.size || 0
  }

  public countableItemsForTag(tag: SNTag): number {
    return this.tagToItemsMap[tag.uuid]?.size || 0
  }

  public countableNotesForFolder(folder: SNFolder, includeDescendants = false): number {
    if (!this.collection.findDecrypted(folder.uuid)) {
      return 0
    }
    const notes = new Set<string>()
    const visited = new Set<string>()
    const pending = [folder.uuid]
    while (pending.length) {
      const uuid = pending.pop()!
      if (visited.has(uuid)) {
        continue
      }
      visited.add(uuid)
      for (const itemUuid of this.tagToItemsMap[uuid] ?? []) {
        if (this.collection.find(itemUuid)?.content_type === ContentType.TYPES.Note) {
          notes.add(itemUuid)
        }
      }
      if (includeDescendants) {
        pending.push(...(this.folderChildren.get(uuid) ?? []))
      }
    }
    return notes.size
  }

  public onChange(delta: ItemDelta): void {
    const folderChanges = [...delta.changed, ...delta.inserted, ...delta.discarded].some(isFolderItem)
    const foldersToRefresh = folderChanges ? new Set(this.folderParents.keys()) : undefined
    if (folderChanges) {
      this.folderParents.clear()
      this.folderChildren.clear()
      for (const folder of this.collection.allDecrypted<SNFolder>(FolderContentType)) {
        this.folderParents.set(folder.uuid, folder.parentId)
        foldersToRefresh?.add(folder.uuid)
        if (folder.parentId) {
          const siblings = this.folderChildren.get(folder.parentId) ?? new Set<string>()
          siblings.add(folder.uuid)
          this.folderChildren.set(folder.parentId, siblings)
        }
      }
    }
    const items = [...delta.changed, ...delta.inserted, ...delta.discarded].filter(
      (i) => i.content_type === ContentType.TYPES.Note || i.content_type === ContentType.TYPES.File,
    )
    const tags = [...delta.changed, ...delta.inserted]
      .filter(isDecryptedItem)
      .filter((item): item is SNTag | SNFolder => isTag(item) || isFolderItem(item))

    this.receiveItemChanges(items)
    this.receiveTagChanges(tags)
    for (const uuid of foldersToRefresh ?? []) {
      this.notifyObservers(uuid)
    }
  }

  private passesAllFilters(element: DecryptedItemInterface): boolean {
    const filters: CriteriaValidatorInterface[] = [new CollectionCriteriaValidator(this.collection, element)]

    if (this.vaultDisplayOptions) {
      const options = this.vaultDisplayOptions.getOptions()
      if (isExclusionaryOptionsValue(options)) {
        filters.push(new ExcludeVaultsCriteriaValidator([...options.exclude, ...options.locked], element))
      } else {
        filters.push(new ExclusiveVaultCriteriaValidator(options.exclusive, element))
      }
    }

    if (this.displayOptions && 'hiddenContentTypes' in this.displayOptions && this.displayOptions.hiddenContentTypes) {
      filters.push(new HiddenContentCriteriaValidator(this.displayOptions.hiddenContentTypes, element))
    }

    if (this.displayOptions && 'customFilter' in this.displayOptions && this.displayOptions.customFilter) {
      filters.push(new CustomFilterCriteriaValidator(this.displayOptions.customFilter, element))
    }

    return filters.every((f) => f.passes())
  }

  private isItemCountable = (item: ItemInterface) => {
    if (item.content_type !== ContentType.TYPES.Note && item.content_type !== ContentType.TYPES.File) {
      return false
    }
    if (isDecryptedItem(item)) {
      const passesFilters = this.passesAllFilters(item)
      return passesFilters && !item.archived && !item.trashed && !item.conflictOf
    }
    return false
  }

  private notifyObservers(tagUuid: string | undefined) {
    const affected = new Set<string | undefined>([tagUuid])
    let parent = tagUuid ? this.folderParents.get(tagUuid) : undefined
    while (parent && !affected.has(parent)) {
      affected.add(parent)
      parent = this.folderParents.get(parent)
    }
    for (const uuid of affected) {
      for (const observer of this.observers) {
        observer(uuid)
      }
    }
  }

  private receiveTagChanges(tags: (SNTag | SNFolder)[]): void {
    for (const tag of tags) {
      const uuids = tag.references
        .filter((ref) => ref.content_type === ContentType.TYPES.Note || ref.content_type === ContentType.TYPES.File)
        .map((ref) => ref.uuid)
      const countableUuids = uuids.filter((uuid) => this.allCountableItems.has(uuid))
      const previousSet = this.tagToItemsMap[tag.uuid]
      this.tagToItemsMap[tag.uuid] = new Set(countableUuids)
      for (const uuid of previousSet ?? []) {
        this.updateCountedTagMembership(uuid, tag.uuid, false)
      }
      for (const uuid of countableUuids) {
        this.updateCountedTagMembership(uuid, tag.uuid, true)
      }

      if (previousSet?.size !== countableUuids.length) {
        this.notifyObservers(tag.uuid)
      }
    }
  }

  private receiveItemChanges(items: ItemInterface[]): void {
    const previousAllCount = this.allCountableItems.size
    const previousNotesCount = this.allCountableNotesCount()
    const previousFilesCount = this.allCountableFilesCount()

    for (const item of items) {
      const isCountable = this.isItemCountable(item)

      if (isCountable) {
        this.allCountableItems.add(item.uuid)

        if (!this.countableItemsByType.has(item.content_type)) {
          this.countableItemsByType.set(item.content_type, new Set())
        }

        this.countableItemsByType.get(item.content_type)?.add(item.uuid)
      } else {
        this.allCountableItems.delete(item.uuid)
        this.countableItemsByType.get(item.content_type)?.delete(item.uuid)
      }

      // Collection.discard removes reverse references before this index runs.
      // Retain counted memberships so remote removal can still clear tag counts.
      const associatedTagUuids = new Set([
        ...this.collection.uuidsThatReferenceUuid(item.uuid),
        ...(this.tagsByCountedItem.get(item.uuid) ?? []),
      ])

      for (const tagUuid of associatedTagUuids) {
        const set = this.setForTag(tagUuid)
        const previousCount = set.size
        if (isCountable) {
          set.add(item.uuid)
        } else {
          set.delete(item.uuid)
        }
        this.updateCountedTagMembership(item.uuid, tagUuid, isCountable)
        if (previousCount !== set.size) {
          this.notifyObservers(tagUuid)
        }
      }
    }

    if (
      previousAllCount !== this.allCountableItems.size ||
      previousNotesCount !== this.allCountableNotesCount() ||
      previousFilesCount !== this.allCountableFilesCount()
    ) {
      this.notifyObservers(undefined)
    }
  }

  private updateCountedTagMembership(itemUuid: string, tagUuid: string, counted: boolean): void {
    let tags = this.tagsByCountedItem.get(itemUuid)
    if (counted) {
      if (!tags) {
        tags = new Set()
        this.tagsByCountedItem.set(itemUuid, tags)
      }
      tags.add(tagUuid)
    } else if (tags) {
      tags.delete(tagUuid)
      if (tags.size === 0) {
        this.tagsByCountedItem.delete(itemUuid)
      }
    }
  }

  private setForTag(uuid: string): Set<string> {
    let set = this.tagToItemsMap[uuid]
    if (!set) {
      set = new Set()
      this.tagToItemsMap[uuid] = set
    }
    return set
  }
}

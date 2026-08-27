import {
  AbstractService,
  InternalEventBusInterface,
  MutatorClientInterface,
  ItemRelationshipDirection,
  AlertService,
} from '@standardnotes/services'
import { FilesClientInterface } from '@standardnotes/files'
import { isClientDisplayableError } from '@standardnotes/responses'
import { ItemsKeyMutator, SNItemsKey } from '@standardnotes/encryption'
import { ContentType } from '@standardnotes/domain-core'
import { ItemManager } from '../Items'
import { PayloadManager } from '../Payloads/PayloadManager'
import { TagsToFoldersMigrationApplicator } from '@Lib/Migrations/Applicators/TagsToFolders'
import {
  ActionsExtensionMutator,
  AppDataField,
  ComponentInterface,
  ComponentMutator,
  CreateDecryptedMutatorForItem,
  DecryptedItemInterface,
  DecryptedItemMutator,
  DecryptedPayload,
  DecryptedPayloadInterface,
  DefaultAppDomain,
  DeleteItemMutator,
  EncryptedItemInterface,
  FeatureRepoMutator,
  FileItem,
  FileMutator,
  FillItemContent,
  ItemContent,
  ItemsKeyInterface,
  ItemsKeyMutatorInterface,
  isLitePayload,
  MutationType,
  NoteMutator,
  PayloadEmitSource,
  PayloadsByDuplicating,
  PayloadTimestampDefaults,
  PayloadVaultOverrides,
  predicateFromDSLString,
  PredicateInterface,
  SmartView,
  SmartViewContent,
  SmartViewDefaultIconName,
  SNActionsExtension,
  SNFeatureRepo,
  SNNote,
  SNTag,
  TagContent,
  TagMutator,
  TransactionalMutation,
  VaultListingInterface,
} from '@standardnotes/models'
import { UuidGenerator, Uuids } from '@standardnotes/utils'

export class MutatorService extends AbstractService implements MutatorClientInterface {
  /**
   * Late-bound to avoid a constructor circular dependency: FileService depends on the
   * MutatorClientInterface, so FileService cannot be injected here at construction time.
   * Wired via {@link setFileService} once both services exist.
   */
  private fileService?: FilesClientInterface

  /**
   * UUIDs of file items whose deletion is currently being driven by FileService.deleteFile.
   * FileService.deleteFile itself calls back into setItemToBeDeleted to remove the item record;
   * this guard ensures that re-entrant call performs the raw item deletion instead of recursing
   * back into FileService.deleteFile.
   */
  private filesBeingDeletedViaFileService = new Set<string>()

  /**
   * Late-bound reader for the FULL on-disk payload of a content-stripped ("lite") item.
   * See {@link setLiteContentRehydrator}. Undefined until wired, and never invoked when
   * `lazyDecryptEnabled` is off, because no item is ever lite in that mode.
   */
  private liteContentRehydrator?: (uuid: string) => Promise<DecryptedPayloadInterface | undefined>

  constructor(
    private itemManager: ItemManager,
    private payloadManager: PayloadManager,
    private alerts: AlertService,
    protected override internalEventBus: InternalEventBusInterface,
  ) {
    super(internalEventBus)
  }

  override deinit() {
    super.deinit()
    ;(this.itemManager as unknown) = undefined
    ;(this.payloadManager as unknown) = undefined
    ;(this.fileService as unknown) = undefined
    this.liteContentRehydrator = undefined
  }

  /**
   * Wires the reader used to re-hydrate a content-stripped ("lite") item before it is mutated
   * (SyncService.getFullContentPayload). Late-bound for the same reason as
   * {@link setFileService}: SyncService is built after MutatorService.
   *
   * WHY THIS LIVES HERE: under `lazyDecryptEnabled` any cold-loaded note is body-less, and the
   * model safety guard deliberately REFUSES to dirty it (it would sync an empty body over the
   * real ciphertext). Every dirtying mutation therefore has to re-hydrate first. Requiring each
   * of the ~60 `changeItem(s)` call sites to remember that is how the trash/delete bug happened,
   * so the re-hydration is done once, here, at the seam that already re-reads the live items by
   * uuid — after the caller's list is resolved and immediately before the mutators are built, so
   * nothing can race in between and only the items actually being mutated are ever loaded.
   */
  public setLiteContentRehydrator(rehydrator: (uuid: string) => Promise<DecryptedPayloadInterface | undefined>): void {
    this.liteContentRehydrator = rehydrator
  }

  /**
   * Replaces any lite (body-stripped) item in `items` with its full on-disk payload so the
   * following dirtying mutation operates on real content.
   *
   * Fails CLOSED: if the body cannot be read back, the item is left lite and the mutator's
   * safety guard throws — refusing the write is the correct outcome, since the alternative is
   * uploading an empty body. Callers surface that to the user.
   *
   * @returns true if any payload was emitted, meaning the caller must re-read its items.
   */
  private async rehydrateLiteItemsForMutation(
    items: (DecryptedItemInterface | undefined)[],
    mutationType: MutationType,
  ): Promise<boolean> {
    /** A non-dirtying mutation never reaches the guard and never syncs, so it needs no body. */
    if (mutationType === MutationType.NonDirtying || !this.liteContentRehydrator) {
      return false
    }

    let didEmit = false

    for (const item of items) {
      if (!item || !isLitePayload(item.payload)) {
        continue
      }

      let full: DecryptedPayloadInterface | undefined
      try {
        full = await this.liteContentRehydrator(item.uuid)
      } catch (error) {
        console.error('Failed to re-hydrate lite item before mutation', item.uuid, error)
        continue
      }

      if (!full || isLitePayload(full)) {
        continue
      }

      /**
       * DATA-LOSS GUARD (rehydrate-clobber race): the disk read above is async, so the live item
       * may have been written since. Only emit the on-disk body while the live item is STILL lite
       * and clean; anything else means a newer write is in flight and this body is stale.
       */
      const live = this.itemManager.findItem(item.uuid)
      if (!live || !isLitePayload(live.payload) || live.dirty) {
        continue
      }

      await this.payloadManager.emitPayload(full, PayloadEmitSource.LocalDatabaseLoaded)
      didEmit = true
    }

    return didEmit
  }

  /**
   * Wires the FileService used to clean up a file's encrypted backing blob (remote + local cache)
   * when a file item is deleted through generic deletion paths (empty-trash, bulk delete, deleting
   * a note path that includes files). Without this, those paths would emit a DeletedPayload for the
   * file item but orphan its blob forever.
   */
  public setFileService(fileService: FilesClientInterface): void {
    this.fileService = fileService
  }

  /**
   * Consumers wanting to modify an item should run it through this block,
   * so that data is properly mapped through our function, and latest state
   * is properly reconciled.
   */
  public async changeItem<
    M extends DecryptedItemMutator = DecryptedItemMutator,
    I extends DecryptedItemInterface = DecryptedItemInterface,
  >(
    itemToLookupUuidFor: I,
    mutate?: (mutator: M) => void,
    mutationType: MutationType = MutationType.UpdateUserTimestamps,
    emitSource = PayloadEmitSource.LocalChanged,
    payloadSourceKey?: string,
  ): Promise<I> {
    const results = await this.changeItems<M, I>(
      [itemToLookupUuidFor],
      mutate,
      mutationType,
      emitSource,
      payloadSourceKey,
    )
    return results[0]
  }

  /**
   * @param mutate If not supplied, the intention would simply be to mark the item as dirty.
   */
  public async changeItems<
    M extends DecryptedItemMutator = DecryptedItemMutator,
    I extends DecryptedItemInterface = DecryptedItemInterface,
  >(
    itemsToLookupUuidsFor: I[],
    mutate?: (mutator: M) => void,
    mutationType: MutationType = MutationType.UpdateUserTimestamps,
    emitSource = PayloadEmitSource.LocalChanged,
    payloadSourceKey?: string,
  ): Promise<I[]> {
    const uuids = Uuids(itemsToLookupUuidsFor)

    let items = this.itemManager.findItemsIncludingBlanks(uuids)

    /** Lazy-decrypt: cold-loaded items are body-less; a dirtying write needs the real body. */
    if (await this.rehydrateLiteItemsForMutation(items, mutationType)) {
      items = this.itemManager.findItemsIncludingBlanks(uuids)
    }

    const payloads: DecryptedPayloadInterface[] = []

    for (const item of items) {
      if (!item) {
        throw Error('Attempting to change non-existant item')
      }
      const mutator = CreateDecryptedMutatorForItem(item, mutationType)
      if (mutate) {
        mutate(mutator as M)
      }
      const payload = mutator.getResult()
      payloads.push(payload)
    }

    await this.payloadManager.emitPayloads(payloads, emitSource, payloadSourceKey)

    const results = this.itemManager.findItems(payloads.map((p) => p.uuid)) as I[]

    return results
  }

  /**
   * Run unique mutations per each item in the array, then only propagate all changes
   * once all mutations have been run. This differs from `changeItems` in that changeItems
   * runs the same mutation on all items.
   */
  public async runTransactionalMutations(
    transactions: TransactionalMutation[],
    emitSource = PayloadEmitSource.LocalChanged,
    payloadSourceKey?: string,
  ): Promise<(DecryptedItemInterface | undefined)[]> {
    const payloads: DecryptedPayloadInterface[] = []

    for (const transaction of transactions) {
      const mutationType = transaction.mutationType || MutationType.UpdateUserTimestamps

      const existing = this.itemManager.findItem(transaction.itemUuid)

      if (!existing) {
        continue
      }

      await this.rehydrateLiteItemsForMutation([existing], mutationType)

      const item = this.itemManager.findItem(transaction.itemUuid) ?? existing

      const mutator = CreateDecryptedMutatorForItem(item, mutationType)

      transaction.mutate(mutator)
      const payload = mutator.getResult()
      payloads.push(payload)
    }

    await this.payloadManager.emitPayloads(payloads, emitSource, payloadSourceKey)
    const results = this.itemManager.findItems(payloads.map((p) => p.uuid))
    return results
  }

  public async runTransactionalMutation(
    transaction: TransactionalMutation,
    emitSource = PayloadEmitSource.LocalChanged,
    payloadSourceKey?: string,
  ): Promise<DecryptedItemInterface | undefined> {
    const mutationType = transaction.mutationType || MutationType.UpdateUserTimestamps

    await this.rehydrateLiteItemsForMutation([this.itemManager.findItem(transaction.itemUuid)], mutationType)

    const item = this.itemManager.findSureItem(transaction.itemUuid)
    const mutator = CreateDecryptedMutatorForItem(item, mutationType)
    transaction.mutate(mutator)
    const payload = mutator.getResult()

    await this.payloadManager.emitPayloads([payload], emitSource, payloadSourceKey)
    const result = this.itemManager.findItem(payload.uuid)
    return result
  }

  async changeNote(
    itemToLookupUuidFor: SNNote,
    mutate: (mutator: NoteMutator) => void,
    mutationType: MutationType = MutationType.UpdateUserTimestamps,
    emitSource = PayloadEmitSource.LocalChanged,
    payloadSourceKey?: string,
  ): Promise<DecryptedPayloadInterface[]> {
    const existing = this.itemManager.findItem<SNNote>(itemToLookupUuidFor.uuid)
    if (!existing) {
      throw Error('Attempting to change non-existant note')
    }

    /** Notes are the only lite-able content type, so this path needs the same re-hydration. */
    await this.rehydrateLiteItemsForMutation([existing], mutationType)

    const note = this.itemManager.findItem<SNNote>(itemToLookupUuidFor.uuid) ?? existing
    const mutator = new NoteMutator(note, mutationType)

    return this.applyTransform(mutator, mutate, emitSource, payloadSourceKey)
  }

  async changeTag(
    itemToLookupUuidFor: SNTag,
    mutate: (mutator: TagMutator) => void,
    mutationType: MutationType = MutationType.UpdateUserTimestamps,
    emitSource = PayloadEmitSource.LocalChanged,
    payloadSourceKey?: string,
  ): Promise<SNTag> {
    const tag = this.itemManager.findItem<SNTag>(itemToLookupUuidFor.uuid)
    if (!tag) {
      throw Error('Attempting to change non-existant tag')
    }
    const mutator = new TagMutator(tag, mutationType)
    await this.applyTransform(mutator, mutate, emitSource, payloadSourceKey)
    return this.itemManager.findSureItem<SNTag>(itemToLookupUuidFor.uuid)
  }

  async changeComponent(
    itemToLookupUuidFor: ComponentInterface,
    mutate: (mutator: ComponentMutator) => void,
    mutationType: MutationType = MutationType.UpdateUserTimestamps,
    emitSource = PayloadEmitSource.LocalChanged,
    payloadSourceKey?: string,
  ): Promise<ComponentInterface> {
    const component = this.itemManager.findItem<ComponentInterface>(itemToLookupUuidFor.uuid)
    if (!component) {
      throw Error('Attempting to change non-existant component')
    }
    const mutator = new ComponentMutator(component, mutationType)
    await this.applyTransform(mutator, mutate, emitSource, payloadSourceKey)
    return this.itemManager.findSureItem<ComponentInterface>(itemToLookupUuidFor.uuid)
  }

  async changeFeatureRepo(
    itemToLookupUuidFor: SNFeatureRepo,
    mutate: (mutator: FeatureRepoMutator) => void,
    mutationType: MutationType = MutationType.UpdateUserTimestamps,
    emitSource = PayloadEmitSource.LocalChanged,
    payloadSourceKey?: string,
  ): Promise<SNFeatureRepo> {
    const repo = this.itemManager.findItem(itemToLookupUuidFor.uuid)
    if (!repo) {
      throw Error('Attempting to change non-existant repo')
    }
    const mutator = new FeatureRepoMutator(repo, mutationType)
    await this.applyTransform(mutator, mutate, emitSource, payloadSourceKey)
    return this.itemManager.findSureItem<SNFeatureRepo>(itemToLookupUuidFor.uuid)
  }

  async changeActionsExtension(
    itemToLookupUuidFor: SNActionsExtension,
    mutate: (mutator: ActionsExtensionMutator) => void,
    mutationType: MutationType = MutationType.UpdateUserTimestamps,
    emitSource = PayloadEmitSource.LocalChanged,
    payloadSourceKey?: string,
  ): Promise<SNActionsExtension> {
    const extension = this.itemManager.findItem<SNActionsExtension>(itemToLookupUuidFor.uuid)
    if (!extension) {
      throw Error('Attempting to change non-existant extension')
    }
    const mutator = new ActionsExtensionMutator(extension, mutationType)
    await this.applyTransform(mutator, mutate, emitSource, payloadSourceKey)
    return this.itemManager.findSureItem<SNActionsExtension>(itemToLookupUuidFor.uuid)
  }

  async changeItemsKey(
    itemToLookupUuidFor: ItemsKeyInterface,
    mutate: (mutator: ItemsKeyMutatorInterface) => void,
    mutationType: MutationType = MutationType.UpdateUserTimestamps,
    emitSource = PayloadEmitSource.LocalChanged,
    payloadSourceKey?: string,
  ): Promise<ItemsKeyInterface> {
    const itemsKey = this.itemManager.findItem<SNItemsKey>(itemToLookupUuidFor.uuid)

    if (!itemsKey) {
      throw Error('Attempting to change non-existant itemsKey')
    }

    const mutator = new ItemsKeyMutator(itemsKey, mutationType)

    await this.applyTransform(mutator, mutate, emitSource, payloadSourceKey)

    return this.itemManager.findSureItem<ItemsKeyInterface>(itemToLookupUuidFor.uuid)
  }

  private async applyTransform<T extends DecryptedItemMutator>(
    mutator: T,
    mutate: (mutator: T) => void,
    emitSource = PayloadEmitSource.LocalChanged,
    payloadSourceKey?: string,
  ): Promise<DecryptedPayloadInterface[]> {
    mutate(mutator)
    const payload = mutator.getResult()
    return this.payloadManager.emitPayload(payload, emitSource, payloadSourceKey)
  }

  /**
   * Sets the item as needing sync. The item is then run through the mapping function,
   * and propagated to mapping observers.
   * @param isUserModified - Whether to update the item's "user modified date"
   */
  public async setItemDirty(itemToLookupUuidFor: DecryptedItemInterface, isUserModified = false) {
    const result = await this.setItemsDirty([itemToLookupUuidFor], isUserModified)
    return result[0]
  }

  public async setItemsDirty(
    itemsToLookupUuidsFor: DecryptedItemInterface[],
    isUserModified = false,
  ): Promise<DecryptedItemInterface[]> {
    return this.changeItems(
      itemsToLookupUuidsFor,
      undefined,
      isUserModified ? MutationType.UpdateUserTimestamps : MutationType.NoUpdateUserTimestamps,
    )
  }

  /**
   * Duplicates an item and maps it, thus propagating the item to observers.
   * @param isConflict - Whether to mark the duplicate as a conflict of the original.
   */
  public async duplicateItem<T extends DecryptedItemInterface>(
    itemToLookupUuidFor: T,
    isConflict = false,
    additionalContent?: Partial<ItemContent>,
  ) {
    const item = this.itemManager.findSureItem(itemToLookupUuidFor.uuid)
    const payload = item.payload.copy()
    const resultingPayloads = PayloadsByDuplicating({
      payload,
      baseCollection: this.payloadManager.getMasterCollection(),
      isConflict,
      additionalContent: {
        appData: {
          [DefaultAppDomain]: {
            [AppDataField.UserModifiedDate]: new Date(),
          },
        },
        ...additionalContent,
      },
    })

    await this.payloadManager.emitPayloads(resultingPayloads, PayloadEmitSource.LocalChanged)
    const duplicate = this.itemManager.findSureItem<T>(resultingPayloads[0].uuid)

    return duplicate
  }

  public async createItem<T extends DecryptedItemInterface, C extends ItemContent = ItemContent>(
    contentType: string,
    content: C,
    needsSync = false,
    vault?: VaultListingInterface,
  ): Promise<T> {
    const payload = new DecryptedPayload<C>({
      uuid: UuidGenerator.GenerateUuid(),
      content_type: contentType,
      content: FillItemContent<C>(content),
      dirty: needsSync,
      ...PayloadVaultOverrides(vault),
      ...PayloadTimestampDefaults(),
    })

    await this.payloadManager.emitPayload(payload, PayloadEmitSource.LocalInserted)

    return this.itemManager.findSureItem<T>(payload.uuid)
  }

  public async insertItem<T extends DecryptedItemInterface>(item: DecryptedItemInterface, setDirty = true): Promise<T> {
    const existingItem = this.itemManager.findItem<T>(item.uuid)
    if (existingItem) {
      throw Error('Attempting to insert item that already exists')
    }

    if (setDirty) {
      const mutator = CreateDecryptedMutatorForItem(item, MutationType.UpdateUserTimestamps)
      const dirtiedPayload = mutator.getResult()
      const insertedItem = await this.emitItemFromPayload<T>(dirtiedPayload, PayloadEmitSource.LocalInserted)
      return insertedItem
    } else {
      return this.emitItemFromPayload(item.payload, PayloadEmitSource.LocalChanged)
    }
  }

  public async insertItems(
    items: DecryptedItemInterface[],
    emitSource: PayloadEmitSource = PayloadEmitSource.LocalInserted,
  ): Promise<DecryptedItemInterface[]> {
    return this.emitItemsFromPayloads(
      items.map((item) => item.payload),
      emitSource,
    )
  }

  public async emitItemFromPayload<T extends DecryptedItemInterface>(
    payload: DecryptedPayloadInterface,
    emitSource: PayloadEmitSource,
  ): Promise<T> {
    await this.payloadManager.emitPayload(payload, emitSource)

    const result = this.itemManager.findSureItem<T>(payload.uuid)

    if (!result) {
      throw Error("Emitted item can't be found")
    }

    return result
  }

  public async emitItemsFromPayloads(
    payloads: DecryptedPayloadInterface[],
    emitSource: PayloadEmitSource,
  ): Promise<DecryptedItemInterface[]> {
    await this.payloadManager.emitPayloads(payloads, emitSource)

    const uuids = Uuids(payloads)

    return this.itemManager.findItems(uuids)
  }

  public async setItemToBeDeleted(
    itemToLookupUuidFor: DecryptedItemInterface | EncryptedItemInterface,
    source: PayloadEmitSource = PayloadEmitSource.LocalChanged,
  ): Promise<void> {
    const isFileItem = itemToLookupUuidFor.content_type === ContentType.TYPES.File

    /**
     * File items carry a remote (and possibly local-cached) encrypted backing blob. Deleting only
     * the item record would orphan that blob forever (storage/cost leak + lingering encrypted data).
     * Route file deletions through FileService.deleteFile so the ValetTokenOperation.Delete +
     * api.deleteFile + local-cache removal happen. The `filesBeingDeletedViaFileService` guard
     * prevents infinite recursion, since FileService.deleteFile itself calls back into this method
     * to remove the item record.
     */
    if (isFileItem && this.fileService && !this.filesBeingDeletedViaFileService.has(itemToLookupUuidFor.uuid)) {
      await this.deleteFileWithBlobCleanup(itemToLookupUuidFor as unknown as FileItem, source)
      return
    }

    return this.removeItemLocally(itemToLookupUuidFor, source)
  }

  /**
   * Drives FileService.deleteFile to clean up a file's backing blob, then ensures the item record
   * is removed. FileService.deleteFile removes the item record itself on success; if blob deletion
   * fails (e.g. offline, or the user declined "delete anyway"), we DO NOT silently swallow it: we
   * surface an alert so the user/next sync can retry, and we still remove the item record so the
   * deletion the caller requested completes (avoiding an inconsistent half-state).
   */
  private async deleteFileWithBlobCleanup(file: FileItem, source: PayloadEmitSource): Promise<void> {
    this.filesBeingDeletedViaFileService.add(file.uuid)

    let blobDeletionError: unknown

    try {
      const result = await this.fileService?.deleteFile(file)
      if (isClientDisplayableError(result)) {
        blobDeletionError = result
      }
    } catch (error) {
      blobDeletionError = error
    } finally {
      this.filesBeingDeletedViaFileService.delete(file.uuid)
    }

    if (blobDeletionError) {
      const message =
        isClientDisplayableError(blobDeletionError) && blobDeletionError.text ? blobDeletionError.text : 'unknown error'
      void this.alerts.alert(
        `The file "${file.name}" was removed, but its stored data could not be deleted from the server (${message}). ` +
          'It will be retried on your next sync.',
      )

      /**
       * deleteFile returned/threw before removing the item record. Remove it now so the requested
       * deletion still completes; the surfaced alert ensures the orphaned blob is not silently lost.
       */
      await this.removeItemLocally(file, source)
    }
  }

  private async removeItemLocally(
    itemToLookupUuidFor: DecryptedItemInterface | EncryptedItemInterface,
    source: PayloadEmitSource = PayloadEmitSource.LocalChanged,
  ): Promise<void> {
    const referencingIdsCapturedBeforeChanges = this.itemManager
      .getCollection()
      .uuidsThatReferenceUuid(itemToLookupUuidFor.uuid)

    const item = this.itemManager.findAnyItem(itemToLookupUuidFor.uuid)
    if (!item) {
      return
    }

    const mutator = new DeleteItemMutator(item, MutationType.UpdateUserTimestamps)

    const deletedPayload = mutator.getDeletedResult()

    await this.payloadManager.emitPayload(deletedPayload, source)

    for (const referencingId of referencingIdsCapturedBeforeChanges) {
      const referencingItem = this.itemManager.findItem(referencingId)

      if (referencingItem) {
        await this.changeItem(referencingItem, (mutator) => {
          mutator.removeItemAsRelationship(item)
        })
      }
    }
  }

  public async setItemsToBeDeleted(
    itemsToLookupUuidsFor: (DecryptedItemInterface | EncryptedItemInterface)[],
  ): Promise<void> {
    await Promise.all(itemsToLookupUuidsFor.map((item) => this.setItemToBeDeleted(item)))
  }

  public async findOrCreateTagParentChain(titlesHierarchy: string[]): Promise<SNTag> {
    let current: SNTag | undefined = undefined

    for (const title of titlesHierarchy) {
      current = await this.findOrCreateTagByTitle({ title, parentItemToLookupUuidFor: current })
    }

    if (!current) {
      throw new Error('Invalid tag hierarchy')
    }

    return current
  }

  public async createTag(dto: {
    title: string
    parentItemToLookupUuidFor?: SNTag
    createInVault?: VaultListingInterface
  }): Promise<SNTag> {
    const newTag = await this.createItem<SNTag>(
      ContentType.TYPES.Tag,
      FillItemContent<TagContent>({ title: dto.title }),
      true,
      dto.createInVault,
    )

    if (dto.parentItemToLookupUuidFor) {
      const parentTag = this.itemManager.findItem<SNTag>(dto.parentItemToLookupUuidFor.uuid)
      if (!parentTag) {
        throw new Error('Invalid parent tag')
      }
      return this.changeTag(newTag, (m) => {
        m.makeChildOf(parentTag)
      })
    }

    return newTag
  }

  public async createSmartView<T extends DecryptedItemInterface>(dto: {
    title: string
    predicate: PredicateInterface<T>
    iconString?: string
    vault?: VaultListingInterface
  }): Promise<SmartView> {
    return this.createItem(
      ContentType.TYPES.SmartView,
      FillItemContent({
        title: dto.title,
        predicate: dto.predicate.toJson(),
        iconString: dto.iconString || SmartViewDefaultIconName,
      } as SmartViewContent),
      true,
      dto.vault,
    ) as Promise<SmartView>
  }

  public async createSmartViewFromDSL<T extends DecryptedItemInterface>(
    dsl: string,
    vault?: VaultListingInterface,
  ): Promise<SmartView> {
    let components = null
    try {
      components = JSON.parse(dsl.substring(1, dsl.length))
    } catch {
      throw Error('Invalid smart view syntax')
    }

    const title = components[0]
    const predicate = predicateFromDSLString<T>(dsl)
    return this.createSmartView({ title, predicate, vault })
  }

  public async createTagOrSmartView<T extends SNTag | SmartView>(
    title: string,
    vault?: VaultListingInterface,
  ): Promise<T> {
    if (this.itemManager.isSmartViewTitle(title)) {
      return this.createSmartViewFromDSL(title, vault) as Promise<T>
    } else {
      return this.createTag({ title, createInVault: vault }) as Promise<T>
    }
  }

  public async findOrCreateTagByTitle(dto: {
    title: string
    parentItemToLookupUuidFor?: SNTag
    createInVault?: VaultListingInterface
  }): Promise<SNTag> {
    const tag = this.itemManager.findTagByTitleAndParent(dto.title, dto.parentItemToLookupUuidFor)
    return tag || this.createTag(dto)
  }

  public renameFile(file: FileItem, name: string): Promise<FileItem> {
    return this.changeItem<FileMutator, FileItem>(file, (mutator) => {
      mutator.name = name
    })
  }

  public setFileDescription(file: FileItem, description: string | undefined): Promise<FileItem> {
    return this.changeItem<FileMutator, FileItem>(file, (mutator) => {
      mutator.description = description
    })
  }

  public async mergeItem(item: DecryptedItemInterface, source: PayloadEmitSource): Promise<DecryptedItemInterface> {
    return this.emitItemFromPayload(item.payloadRepresentation(), source)
  }

  public async setItemNeedsSync(
    item: DecryptedItemInterface,
    updateTimestamps = false,
  ): Promise<DecryptedItemInterface | undefined> {
    return this.setItemDirty(item, updateTimestamps)
  }

  public async setItemsNeedsSync(items: DecryptedItemInterface[]): Promise<(DecryptedItemInterface | undefined)[]> {
    return this.setItemsDirty(items)
  }

  public async deleteItem(item: DecryptedItemInterface | EncryptedItemInterface): Promise<void> {
    return this.deleteItems([item])
  }

  public async deleteItems(items: (DecryptedItemInterface | EncryptedItemInterface)[]): Promise<void> {
    await this.setItemsToBeDeleted(items)
  }

  /**
   * Permanently deletes any items currently in the trash. Consumer must manually call sync.
   * Includes trashed FILE items (not just notes) so their encrypted backing blobs are cleaned up
   * via FileService.deleteFile rather than orphaned.
   */
  public async emptyTrash(): Promise<void> {
    const trashedNotes = this.itemManager.trashedItems
    const trashedFiles = this.itemManager.getItems<FileItem>(ContentType.TYPES.File).filter((file) => file.trashed)
    await this.setItemsToBeDeleted([...trashedNotes, ...trashedFiles])
  }

  public async migrateTagsToFolders(): Promise<void> {
    await TagsToFoldersMigrationApplicator.run(this.itemManager, this)
  }

  public async findOrCreateTag(title: string, createInVault?: VaultListingInterface): Promise<SNTag> {
    return this.findOrCreateTagByTitle({ title, createInVault })
  }

  /**
   * @returns The changed child tag
   */
  public async setTagParent(parentTag: SNTag, childTag: SNTag): Promise<SNTag> {
    if (parentTag.uuid === childTag.uuid) {
      throw new Error('Can not set a tag parent of itself')
    }

    if (this.itemManager.isTagAncestor(childTag, parentTag)) {
      throw new Error('Can not set a tag ancestor of itself')
    }

    return this.changeTag(childTag, (m) => {
      m.makeChildOf(parentTag)
    })
  }

  /**
   * @returns The changed child tag
   */
  public unsetTagParent(childTag: SNTag): Promise<SNTag> {
    const parentTag = this.itemManager.getTagParent(childTag)

    if (!parentTag) {
      return Promise.resolve(childTag)
    }

    return this.changeTag(childTag, (m) => {
      m.unsetParent()
    })
  }

  public async associateFileWithNote(file: FileItem, note: SNNote): Promise<FileItem | undefined> {
    const isVaultConflict =
      file.key_system_identifier &&
      note.key_system_identifier &&
      file.key_system_identifier !== note.key_system_identifier

    if (isVaultConflict) {
      void this.alerts.alert('The items you are trying to link belong to different vaults and cannot be linked')
      return undefined
    }

    return this.changeItem<FileMutator, FileItem>(file, (mutator) => {
      mutator.addNote(note)
    })
  }

  public async disassociateFileWithNote(file: FileItem, note: SNNote): Promise<FileItem> {
    return this.changeItem<FileMutator, FileItem>(file, (mutator) => {
      mutator.removeNote(note)
    })
  }

  public async addTagToNote(note: SNNote, tag: SNTag, addHierarchy: boolean): Promise<SNTag[] | undefined> {
    if (tag.key_system_identifier !== note.key_system_identifier) {
      void this.alerts.alert('The items you are trying to link belong to different vaults and cannot be linked')
      return undefined
    }

    let tagsToAdd = [tag]

    if (addHierarchy) {
      const parentChainTags = this.itemManager.getTagParentChain(tag)
      tagsToAdd = [...parentChainTags, tag]
    }

    return Promise.all(
      tagsToAdd.map((tagToAdd) => {
        return this.changeTag(tagToAdd, (mutator) => {
          mutator.addNote(note)
        }) as Promise<SNTag>
      }),
    )
  }

  public async addTagToFile(file: FileItem, tag: SNTag, addHierarchy: boolean): Promise<SNTag[] | undefined> {
    if (tag.key_system_identifier !== file.key_system_identifier) {
      void this.alerts.alert('The items you are trying to link belong to different vaults and cannot be linked')
      return undefined
    }

    let tagsToAdd = [tag]

    if (addHierarchy) {
      const parentChainTags = this.itemManager.getTagParentChain(tag)
      tagsToAdd = [...parentChainTags, tag]
    }

    return Promise.all(
      tagsToAdd.map((tagToAdd) => {
        return this.changeTag(tagToAdd, (mutator) => {
          mutator.addFile(file)
        }) as Promise<SNTag>
      }),
    )
  }

  public async linkNoteToNote(note: SNNote, otherNote: SNNote): Promise<SNNote> {
    return this.changeItem<NoteMutator, SNNote>(note, (mutator) => {
      mutator.addNote(otherNote)
    })
  }

  public async linkFileToFile(file: FileItem, otherFile: FileItem): Promise<FileItem> {
    return this.changeItem<FileMutator, FileItem>(file, (mutator) => {
      mutator.addFile(otherFile)
    })
  }

  public async unlinkItems(
    itemA: DecryptedItemInterface<ItemContent>,
    itemB: DecryptedItemInterface<ItemContent>,
  ): Promise<DecryptedItemInterface<ItemContent>> {
    const relationshipDirection = this.itemManager.relationshipDirectionBetweenItems(itemA, itemB)

    if (relationshipDirection === ItemRelationshipDirection.NoRelationship) {
      throw new Error('Trying to unlink already unlinked items')
    }

    const itemToChange = relationshipDirection === ItemRelationshipDirection.AReferencesB ? itemA : itemB
    const itemToRemove = itemToChange === itemA ? itemB : itemA

    return this.changeItem(itemToChange, (mutator) => {
      mutator.removeItemAsRelationship(itemToRemove)
    })
  }
}

import {
  confirmDialog,
  CREATE_NEW_TAG_COMMAND,
  NavigationControllerPersistableValue,
  VaultDisplayService,
  VaultDisplayServiceEvent,
} from '@standardnotes/ui-services'
import { STRING_DELETE_TAG, StringUtils } from '@/Constants/Strings'
import { SMART_TAGS_FEATURE_NAME } from '@/Constants/Constants'
import {
  ContentType,
  SmartView,
  SNNote,
  SNTag,
  TagContent,
  TagMutator,
  NoteMutator,
  isNote,
  UuidString,
  isSystemView,
  FindItem,
  SystemViewId,
  InternalEventPublishStrategy,
  VectorIconNameOrEmoji,
  isTag,
  PrefKey,
  ApplicationEvent,
  InternalEventBusInterface,
  InternalEventHandlerInterface,
  InternalEventInterface,
  ItemManagerInterface,
  SyncServiceInterface,
  MutatorClientInterface,
  AlertService,
  PreferenceServiceInterface,
  ChangeAndSaveItem,
  SNFolder,
  FolderMutator,
  FolderContentType,
  FolderContent,
  FileItem,
  PrefDefaults,
} from '@standardnotes/snjs'
import { action, computed, makeObservable, observable, reaction, runInAction } from 'mobx'
import { FeaturesController } from '../FeaturesController'
import { debounce, destroyAllObjectProperties } from '@/Utils'
import { isValidFutureSiblings, rootTags, tagSiblings } from './Utils'
import { AnyTag } from './AnyTagType'
import { CrossControllerEvent } from '../CrossControllerEvent'
import { AbstractViewController } from '../Abstract/AbstractViewController'
import { Persistable } from '../Abstract/Persistable'
import { TagListSectionType } from '@/Components/Tags/TagListSection'
import { PaneLayout } from '../PaneController/PaneLayout'
import { TagsCountsState } from './TagsCountsState'
import { PaneController } from '../PaneController/PaneController'
import { RecentActionsState } from '../../Application/Recents'
import { CommandService } from '../../Components/CommandPalette/CommandService'

export class NavigationController
  extends AbstractViewController
  implements Persistable<NavigationControllerPersistableValue>, InternalEventHandlerInterface
{
  tags: SNTag[] = []
  folders: SNFolder[] = []
  smartViews: SmartView[] = []
  starredTags: SNTag[] = []
  selectedFolder_: SNFolder | undefined = undefined
  editingFolder_: SNFolder | undefined = undefined
  addingSubfolderTo: SNFolder | undefined = undefined
  contextMenuFolder: SNFolder | undefined = undefined
  allNotesCount_ = 0
  allFilesCount_ = 0
  selectedUuid: AnyTag['uuid'] | undefined = undefined
  selected_: AnyTag | undefined = undefined
  selectedLocation: TagListSectionType | undefined = undefined
  previouslySelected_: AnyTag | undefined = undefined
  editing_: SNTag | SmartView | undefined = undefined
  addingSubtagTo: SNTag | undefined = undefined
  tagToScrollIntoView: AnyTag | undefined = undefined

  contextMenuOpen = false
  contextMenuClickLocation: { x: number; y: number } = { x: 0, y: 0 }
  contextMenuTag: SNTag | undefined = undefined
  contextMenuTagSection: TagListSectionType | undefined = undefined

  searchQuery = ''

  // Standard Red Notes: cached custom (manual drag) orderings for the navigation
  // sidebar, mirrored from preferences as observable state so reorders re-render.
  customFoldersOrder_: string[] = []
  customTagsOrder_: string[] = []

  private readonly tagsCountsState: TagsCountsState

  constructor(
    private featuresController: FeaturesController,
    private vaultDisplayService: VaultDisplayService,
    private commands: CommandService,
    private paneController: PaneController,
    private sync: SyncServiceInterface,
    private mutator: MutatorClientInterface,
    private items: ItemManagerInterface,
    private preferences: PreferenceServiceInterface,
    private alerts: AlertService,
    private _changeAndSaveItem: ChangeAndSaveItem,
    private recents: RecentActionsState,
    eventBus: InternalEventBusInterface,
  ) {
    super(eventBus)

    eventBus.addEventHandler(this, VaultDisplayServiceEvent.VaultDisplayOptionsChanged)
    eventBus.addEventHandler(this, ApplicationEvent.PreferencesChanged)

    this.tagsCountsState = new TagsCountsState(items)
    this.smartViews = items.getSmartViews()
    this.folders = items.getItems<SNFolder>(FolderContentType)

    makeObservable(this, {
      tags: observable,
      folders: observable,
      starredTags: observable,
      smartViews: observable.ref,

      selectedFolder_: observable.ref,
      selectedFolder: computed,
      setSelectedFolder: action,
      editingFolder_: observable.ref,
      editingFolder: computed,
      setEditingFolder: action,
      addingSubfolderTo: observable.ref,
      setAddingSubfolderTo: action,
      contextMenuFolder: observable.ref,
      setContextMenuFolder: action,
      createFolder: action,
      removeFolder: action,
      createNewFolderTemplate: action,
      allNotesCount_: observable,
      allFilesCount_: observable,
      allNotesCount: computed,
      allFilesCount: computed,
      setAllNotesCount: action,
      setAllFilesCount: action,

      selected_: observable,
      selectedLocation: observable,
      previouslySelected_: observable.ref,
      previouslySelected: computed,
      editing_: observable.ref,
      selected: computed,
      selectedUuid: observable,
      editingTag: computed,

      addingSubtagTo: observable,
      setAddingSubtagTo: action,

      assignParent: action,

      rootTags: computed,
      allLocalRootFolders: computed,
      allLocalRootTags: computed,
      allLocalFlatTags: computed,
      tagsCount: computed,

      customFoldersOrder_: observable.ref,
      customTagsOrder_: observable.ref,
      reloadCustomOrders: action,

      createNewTemplate: action,
      undoCreateNewTag: action,
      save: action,
      remove: action,

      contextMenuOpen: observable,
      contextMenuClickLocation: observable,
      setContextMenuOpen: action,
      setContextMenuClickLocation: action,
      contextMenuTag: observable,
      setContextMenuTag: action,

      isInFilesView: computed,

      hydrateFromPersistedValue: action,

      searchQuery: observable,
      setSearchQuery: action,
    })

    this.disposers.push(
      this.items.streamItems([ContentType.TYPES.Tag, ContentType.TYPES.SmartView], ({ changed, removed }) => {
        this.reloadTags()

        if (this.contextMenuTag && FindItem(removed, this.contextMenuTag.uuid)) {
          this.setContextMenuTag(undefined)
        }

        runInAction(() => {
          const currentSelectedTag = this.selected_

          if (!currentSelectedTag) {
            return
          }

          const updatedReference =
            FindItem(changed, currentSelectedTag.uuid) || FindItem(this.smartViews, currentSelectedTag.uuid)
          if (updatedReference) {
            this.setSelectedTagInstance(updatedReference as AnyTag)
          }

          if (isSystemView(currentSelectedTag as SmartView)) {
            return
          }

          if (FindItem(removed, currentSelectedTag.uuid)) {
            this.setSelectedTagInstance(this.smartViews[0])
          }
        })
      }),
    )

    this.disposers.push(
      this.items.streamItems<SNFolder>([FolderContentType], ({ removed }) => {
        this.reloadFolders()

        if (this.contextMenuFolder && FindItem(removed, this.contextMenuFolder.uuid)) {
          this.setContextMenuFolder(undefined)
        }

        runInAction(() => {
          const currentSelectedFolder = this.selectedFolder_
          if (!currentSelectedFolder) {
            return
          }
          const updated = this.folders.find((folder) => folder.uuid === currentSelectedFolder.uuid)
          if (updated) {
            this.selectedFolder_ = updated
            if (this.selectedUuid === currentSelectedFolder.uuid) {
              this.selected_ = updated as unknown as AnyTag
            }
          } else if (FindItem(removed, currentSelectedFolder.uuid)) {
            void this.selectHomeNavigationView()
          }
        })

        void this.runFolderMigrationIfNeeded()
      }),
    )

    this.disposers.push(
      this.items.addNoteCountChangeObserver((tagUuid) => {
        if (!tagUuid) {
          this.setAllNotesCount(this.items.allCountableNotesCount())
          this.setAllFilesCount(this.items.allCountableFilesCount())
        } else {
          const tag = this.items.findItem<SNTag>(tagUuid)
          if (tag) {
            this.tagsCountsState.update([tag])
          }
        }
      }),
    )

    this.disposers.push(
      reaction(
        () => this.selectedUuid,
        () => {
          eventBus.publish({
            type: CrossControllerEvent.RequestValuePersistence,
            payload: undefined,
          })
        },
      ),
    )

    this.disposers.push(
      this.commands.addWithShortcut(
        CREATE_NEW_TAG_COMMAND,
        'General',
        'Create new tag',
        () => this.createNewTemplate(),
        'add',
      ),
    )

    this.setDisplayOptionsAndReloadTags = debounce(this.setDisplayOptionsAndReloadTags, 50)

    this.reloadCustomOrders()
  }

  private reloadFolders(): void {
    runInAction(() => {
      this.folders = this.items.getItems<SNFolder>(FolderContentType)
    })
  }

  private reloadTags(): void {
    runInAction(() => {
      this.tags = this.items.getDisplayableTags()
      this.starredTags = this.tags.filter((tag) => tag.starred)
      this.smartViews = this.items.getSmartViews().filter((view) => {
        if (!this.isSearching) {
          return true
        }
        return !isSystemView(view)
      })
    })
  }

  async handleEvent(event: InternalEventInterface): Promise<void> {
    if (event.type === VaultDisplayServiceEvent.VaultDisplayOptionsChanged) {
      this.reloadTags()
      if (this.selectedUuid) {
        this.findAndSetTag(this.selectedUuid)
      } else {
        this.selectHomeNavigationView().catch(console.error)
      }
    } else if (event.type === ApplicationEvent.PreferencesChanged) {
      // Standard Red Notes: refresh cached custom folder/tag orderings so the
      // navigation lists re-render after a drag-reorder (or remote pref sync).
      this.reloadCustomOrders()
    }
  }

  private findAndSetTag = (uuid: UuidString) => {
    const tagToSelect = [...this.tags, ...this.smartViews].find((tag) => tag.uuid === uuid)
    if (tagToSelect) {
      void this.setSelectedTag(tagToSelect, isTag(tagToSelect) ? (tagToSelect.starred ? 'favorites' : 'all') : 'views')
    }
  }

  private selectHydratedTagOrDefault = () => {
    if (this.selectedUuid && !this.selected_) {
      this.findAndSetTag(this.selectedUuid)
    }

    if (!this.selectedUuid) {
      void this.selectHomeNavigationView()
    }
  }

  getPersistableValue = (): NavigationControllerPersistableValue => {
    return {
      selectedTagUuid: this.selectedUuid ? this.selectedUuid : SystemViewId.AllNotes,
    }
  }

  hydrateFromPersistedValue = (state: NavigationControllerPersistableValue | undefined) => {
    const uuidsToPreventHydrationOf: string[] = [SystemViewId.Files]

    if (!state || uuidsToPreventHydrationOf.includes(state.selectedTagUuid)) {
      void this.selectHomeNavigationView()
      return
    }

    if (state.selectedTagUuid) {
      this.selectedUuid = state.selectedTagUuid
      this.selectHydratedTagOrDefault()
    }
  }

  override deinit() {
    super.deinit()
    ;(this.featuresController as unknown) = undefined
    ;(this.tags as unknown) = undefined
    ;(this.folders as unknown) = undefined
    ;(this.selectedFolder_ as unknown) = undefined
    ;(this.editingFolder_ as unknown) = undefined
    ;(this.smartViews as unknown) = undefined
    ;(this.selected_ as unknown) = undefined
    ;(this.previouslySelected_ as unknown) = undefined
    ;(this.editing_ as unknown) = undefined
    ;(this.addingSubtagTo as unknown) = undefined
    ;(this.featuresController as unknown) = undefined

    destroyAllObjectProperties(this)
  }

  async createSubtagAndAssignParent(parent: SNTag, title: string) {
    const hasEmptyTitle = title.length === 0

    if (hasEmptyTitle) {
      this.setAddingSubtagTo(undefined)
      return
    }

    const createdTag = await this.mutator.createTagOrSmartView<SNTag>(
      title,
      this.vaultDisplayService.exclusivelyShownVault,
    )

    const futureSiblings = this.items.getTagChildren(parent)

    if (!isValidFutureSiblings(this.alerts, futureSiblings, createdTag)) {
      this.setAddingSubtagTo(undefined)
      this.remove(createdTag, false).catch(console.error)
      return
    }

    this.assignParent(createdTag.uuid, parent.uuid).catch(console.error)

    this.sync.sync().catch(console.error)

    runInAction(() => {
      void this.setSelectedTag(createdTag as SNTag, 'all')
    })

    this.setAddingSubtagTo(undefined)
  }

  public isInSmartView(): boolean {
    return this.selected instanceof SmartView
  }

  public isInHomeView(): boolean {
    return this.selected instanceof SmartView && this.selected.uuid === SystemViewId.AllNotes
  }

  public get isInFilesView(): boolean {
    return this.selectedUuid === SystemViewId.Files
  }

  isTagFilesView(tag: AnyTag): boolean {
    return tag.uuid === SystemViewId.Files
  }

  tagUsesTableView(tag: AnyTag): boolean {
    const isSystemView = tag instanceof SmartView && Object.values(SystemViewId).includes(tag.uuid as SystemViewId)
    const useTableView = isSystemView
      ? this.preferences.getValue(PrefKey.SystemViewPreferences)?.[tag.uuid as SystemViewId]
      : tag?.preferences
    return Boolean(useTableView)
  }

  public isInAnySystemView(): boolean {
    return (
      this.selected instanceof SmartView && Object.values(SystemViewId).includes(this.selected.uuid as SystemViewId)
    )
  }

  public isInSystemView(id: SystemViewId): boolean {
    return this.selected instanceof SmartView && this.selected.uuid === id
  }

  public get selectedAsTag(): SNTag | undefined {
    if (!this.selected || !isTag(this.selected)) {
      return undefined
    }
    return this.selected
  }

  setAddingSubtagTo(tag: SNTag | undefined): void {
    this.addingSubtagTo = tag
  }

  setContextMenuOpen(open: boolean): void {
    this.contextMenuOpen = open
  }

  setContextMenuClickLocation(location: { x: number; y: number }): void {
    this.contextMenuClickLocation = location
  }

  setContextMenuTag(tag: SNTag | undefined, section: TagListSectionType = 'all'): void {
    this.contextMenuTag = tag
    this.contextMenuTagSection = section
  }

  /**
   * Standard Red Notes: stable-sort a sibling group of folders/tags by a persisted
   * custom order (array of uuids). Items present in the order sort by ascending
   * index; items absent keep their existing relative order and are appended at the
   * end. Sorting per-sibling-group preserves the parent/child hierarchy — a single
   * global order array is reused at every level. Template (in-progress create) rows
   * are never reordered and remain at the front via the callers below.
   */
  private applyCustomOrder<T extends { uuid: string }>(items: T[], order: string[]): T[] {
    if (order.length === 0) {
      return items
    }
    const indexOf = new Map<string, number>()
    order.forEach((uuid, index) => indexOf.set(uuid, index))
    return [...items]
      .map((item, originalIndex) => ({ item, originalIndex }))
      .sort((a, b) => {
        const aIndex = indexOf.has(a.item.uuid) ? (indexOf.get(a.item.uuid) as number) : Number.MAX_SAFE_INTEGER
        const bIndex = indexOf.has(b.item.uuid) ? (indexOf.get(b.item.uuid) as number) : Number.MAX_SAFE_INTEGER
        if (aIndex !== bIndex) {
          return aIndex - bIndex
        }
        return a.originalIndex - b.originalIndex
      })
      .map((entry) => entry.item)
  }

  private get customTagsOrder(): string[] {
    return this.customTagsOrder_
  }

  private get customFoldersOrder(): string[] {
    return this.customFoldersOrder_
  }

  /**
   * Standard Red Notes: refresh the cached custom orderings from preferences. Held
   * as observable state (rather than read inline) so that MobX re-renders the
   * navigation lists when the user reorders (which rewrites these prefs). Called on
   * construction and whenever preferences change.
   */
  public reloadCustomOrders(): void {
    runInAction(() => {
      this.customFoldersOrder_ = this.preferences.getValue(
        PrefKey.CustomFoldersOrder,
        PrefDefaults[PrefKey.CustomFoldersOrder],
      )
      this.customTagsOrder_ = this.preferences.getValue(PrefKey.CustomTagsOrder, PrefDefaults[PrefKey.CustomTagsOrder])
    })
  }

  public get allLocalRootTags(): SNTag[] {
    const ordered = this.applyCustomOrder(this.rootTags, this.customTagsOrder)
    if (this.editing_ instanceof SNTag && this.items.isTemplateItem(this.editing_)) {
      return [this.editing_, ...ordered]
    }
    return ordered
  }

  /** Root-level folders (no parent folder) for the hierarchical Folders section. */
  public get allLocalRootFolders(): SNFolder[] {
    const roots = this.applyCustomOrder(
      this.folders.filter((folder) => !folder.parentId),
      this.customFoldersOrder,
    )
    if (this.editingFolder_ && this.items.isTemplateItem(this.editingFolder_) && !this.editingFolder_.parentId) {
      return [this.editingFolder_, ...roots]
    }
    return roots
  }

  /**
   * Standard Red Notes: persist a new sibling ordering after a drag-reorder.
   * `orderedSiblingUuids` is the desired order of the reordered group; we merge it
   * ahead of any previously-ordered uuids not in this group so other levels keep
   * their order. The pref change streams back through observers and re-renders.
   */
  public async reorderFolderSiblings(orderedSiblingUuids: string[]): Promise<void> {
    await this.persistSiblingOrder(PrefKey.CustomFoldersOrder, this.customFoldersOrder, orderedSiblingUuids)
  }

  public async reorderTagSiblings(orderedSiblingUuids: string[]): Promise<void> {
    await this.persistSiblingOrder(PrefKey.CustomTagsOrder, this.customTagsOrder, orderedSiblingUuids)
  }

  private async persistSiblingOrder(
    key: PrefKey.CustomFoldersOrder | PrefKey.CustomTagsOrder,
    previous: string[],
    orderedSiblingUuids: string[],
  ): Promise<void> {
    const groupSet = new Set(orderedSiblingUuids)
    const preserved = previous.filter((uuid) => !groupSet.has(uuid))
    await this.preferences.setValue(key, [...orderedSiblingUuids, ...preserved])
  }

  /**
   * Standard Red Notes: compute the new sibling order when `draggedUuid` is dropped
   * onto `targetUuid` within `siblings` (placing the dragged item immediately before
   * the target), then persist it. Used by the folders/tags drag-reorder handlers.
   */
  public async reorderSiblingByDrag(
    kind: 'folders' | 'tags',
    siblings: { uuid: string }[],
    draggedUuid: string,
    targetUuid: string,
  ): Promise<void> {
    if (draggedUuid === targetUuid) {
      return
    }
    const order = siblings.map((sibling) => sibling.uuid)
    if (!order.includes(draggedUuid) || !order.includes(targetUuid)) {
      return
    }
    const without = order.filter((uuid) => uuid !== draggedUuid)
    const targetIndex = without.indexOf(targetUuid)
    without.splice(targetIndex, 0, draggedUuid)
    if (kind === 'folders') {
      await this.reorderFolderSiblings(without)
    } else {
      await this.reorderTagSiblings(without)
    }
  }

  /** All tags (labels), shown flat. Tags are never folders anymore. */
  public get allLocalFlatTags(): SNTag[] {
    const flat = this.tags
    if (this.editing_ instanceof SNTag && this.items.isTemplateItem(this.editing_)) {
      return [this.editing_, ...flat]
    }
    return flat
  }

  /** Subfolders of a folder. The Folders tree shows folders only; a folder's notes appear in the note list. */
  public getFolderChildren(folder: SNFolder): SNFolder[] {
    if (this.items.isTemplateItem(folder) || this.isSearching) {
      return []
    }
    return this.applyCustomOrder(
      this.folders.filter((candidate) => candidate.parentId === folder.uuid),
      this.customFoldersOrder,
    )
  }

  /**
   * Standard Red Notes: the ordered sibling group of a folder (its parent's
   * children, or the root folders) — used to compute a drag-reorder.
   */
  public getFolderSiblings(folder: SNFolder): SNFolder[] {
    if (folder.parentId) {
      return this.folders.filter((candidate) => candidate.parentId === folder.parentId)
    }
    return this.folders.filter((candidate) => !candidate.parentId)
  }

  /** Standard Red Notes: the ordered sibling group of a tag (its parent's children, or the root tags). */
  public getTagSiblings(tag: SNTag): SNTag[] {
    const parent = this.items.getDisplayableTagParent(tag)
    if (parent) {
      const childUuids = this.items.getTagChildren(parent).map((child) => child.uuid)
      return this.tags.filter((candidate) => childUuids.includes(candidate.uuid))
    }
    return this.rootTags
  }

  /** The single folder a note lives in (its location), if any. */
  public getNoteFolder(note: SNNote): SNFolder | undefined {
    return this.folders.find((folder) => folder.noteReferences.some((ref) => ref.uuid === note.uuid))
  }

  /**
   * Move a note into a folder (its exclusive location), or out of all folders when
   * `folder` is undefined. Folder membership is single-valued — unlike tags, which
   * stay many-to-many labels.
   */
  public async moveNoteToFolder(note: SNNote, folder: SNFolder | undefined): Promise<void> {
    const currentFolders = this.folders.filter((candidate) =>
      candidate.noteReferences.some((ref) => ref.uuid === note.uuid),
    )
    for (const current of currentFolders) {
      if (current.uuid !== folder?.uuid) {
        await this.mutator.changeItem<FolderMutator>(current, (m) => m.removeNote(note))
      }
    }
    if (folder) {
      await this.mutator.changeItem<FolderMutator>(folder, (m) => m.addNote(note))
    }
    await this.sync.sync()
  }

  /** The single folder a file lives in (its location), if any. */
  public getFileFolder(file: FileItem): SNFolder | undefined {
    return this.folders.find((folder) => folder.isReferencingItem(file))
  }

  /**
   * Move a file into a folder (its exclusive location), or out of all folders when
   * `folder` is undefined. Mirrors `moveNoteToFolder` but uses the generic relationship
   * mutators since folders track files via generic references (not `noteReferences`).
   */
  public async moveFileToFolder(file: FileItem, folder: SNFolder | undefined): Promise<void> {
    const currentFolders = this.folders.filter((candidate) => candidate.isReferencingItem(file))
    for (const current of currentFolders) {
      if (current.uuid !== folder?.uuid) {
        await this.mutator.changeItem<FolderMutator>(current, (m) => m.removeItemAsRelationship(file))
      }
    }
    if (folder) {
      await this.mutator.changeItem<FolderMutator>(folder, (m) => m.e2ePendingRefactor_addItemAsRelationship(file))
    }
    await this.sync.sync()
  }

  /**
   * Collects the member notes of a tag or folder. Both `SNTag` and `SNFolder` expose
   * `noteReferences` (the notes they reference). We resolve those references to live note
   * items, skipping any that no longer exist.
   */
  public memberNotesOfTagOrFolder(tagOrFolder: SNTag | SNFolder): SNNote[] {
    const noteUuids = tagOrFolder.noteReferences.map((ref) => ref.uuid)
    return this.items.findItems<SNNote>(noteUuids).filter(isNote)
  }

  public tagOrFolderHasAnyLocalOnlyNotes(tagOrFolder: SNTag | SNFolder): boolean {
    return this.memberNotesOfTagOrFolder(tagOrFolder).some((note) => note.localOnly)
  }

  /**
   * Applies (or clears) the "local only" / exclude-from-sync flag to every member note of a
   * tag or folder. Per the design, this operates on the member NOTES (not the tag/folder
   * container itself): excluding the notes is what keeps their content off the server.
   *
   * Edge case (documented, not silently handled): a note that is a member of a SYNCED tag
   * may be marked local-only here. The tag still references it (and the tag continues to
   * sync, carrying that reference). The note's content stays local; only the membership
   * reference is visible on the server. We do not strip the reference, to avoid surprising
   * data changes to the shared tag.
   */
  public async setTagOrFolderNotesLocalOnly(tagOrFolder: SNTag | SNFolder, localOnly: boolean): Promise<void> {
    const notes = this.memberNotesOfTagOrFolder(tagOrFolder)
    if (notes.length === 0) {
      return
    }

    await this.mutator.changeItems<NoteMutator, SNNote>(notes, (mutator) => {
      mutator.localOnly = localOnly
    })

    await this.sync.sync()
  }

  public get selectedFolder(): SNFolder | undefined {
    return this.selectedFolder_
  }

  setContextMenuFolder(folder: SNFolder | undefined, section: TagListSectionType = 'folders'): void {
    this.contextMenuFolder = folder
    this.contextMenuTagSection = section
  }

  setAddingSubfolderTo(folder: SNFolder | undefined): void {
    this.addingSubfolderTo = folder
  }

  public get editingFolder(): SNFolder | undefined {
    return this.editingFolder_
  }

  setEditingFolder(folder: SNFolder | undefined): void {
    runInAction(() => {
      this.editingFolder_ = folder
    })
  }

  /**
   * Select a folder so the note list filters to the notes it references. We publish the
   * same TagChanged event the tag selection uses so ItemListController re-runs its display
   * options (which now include the selected folder as a criterion). The selected tag/view
   * is cleared so only the folder filter applies.
   */
  public async setSelectedFolder(
    folder: SNFolder,
    options?: { userTriggered: boolean; scrollIntoView?: boolean },
  ): Promise<void> {
    const { userTriggered = false } = options || {}

    if (this.items.isTemplateItem(folder)) {
      return
    }

    if (userTriggered) {
      this.paneController.setPaneLayout(PaneLayout.ItemSelection)
    }

    this.previouslySelected_ = this.selected_

    await runInAction(async () => {
      this.selectedFolder_ = folder
      this.selected_ = folder as unknown as AnyTag
      this.selectedUuid = folder.uuid
      this.selectedLocation = 'folders'

      this.recents.add(folder.uuid)

      await this.eventBus.publishSync(
        {
          type: CrossControllerEvent.TagChanged,
          payload: { tag: folder, previousTag: this.previouslySelected_, userTriggered },
        },
        InternalEventPublishStrategy.SEQUENCE,
      )
    })
  }

  /** Create a new SNFolder, optionally nested under `parent`, then select it. */
  public async createFolder(title: string, parent?: SNFolder): Promise<void> {
    if (title.length === 0) {
      this.setAddingSubfolderTo(undefined)
      this.setEditingFolder(undefined)
      return
    }

    const template = this.items.createTemplateItem<FolderContent, SNFolder>(FolderContentType, {
      title,
    } as unknown as FolderContent)

    const created = await this.mutator.insertItem<SNFolder>(template)

    if (parent) {
      await this.mutator.changeItem<FolderMutator>(created, (m) => m.makeChildOf(parent))
    }

    await this.sync.sync()

    this.reloadFolders()

    const inserted = this.folders.find((folder) => folder.uuid === created.uuid) || created

    runInAction(() => {
      this.setAddingSubfolderTo(undefined)
      this.setEditingFolder(undefined)
      void this.setSelectedFolder(inserted, { userTriggered: true })
    })
  }

  /**
   * Standard Red Notes: create a folder and return the live item, without
   * selecting it. Used by bulk/folder uploads which create many folders quickly
   * and should not hijack the user's current selection or close the inline editor.
   */
  public async createFolderReturning(title: string, parent?: SNFolder): Promise<SNFolder | undefined> {
    const trimmed = title.trim()
    if (trimmed.length === 0) {
      return undefined
    }

    const template = this.items.createTemplateItem<FolderContent, SNFolder>(FolderContentType, {
      title: trimmed,
    } as unknown as FolderContent)

    const created = await this.mutator.insertItem<SNFolder>(template)

    if (parent) {
      await this.mutator.changeItem<FolderMutator>(created, (m) => m.makeChildOf(parent))
    }

    await this.sync.sync()
    this.reloadFolders()

    return this.folders.find((folder) => folder.uuid === created.uuid) || (created as SNFolder)
  }

  /** Find an existing child folder (or root folder when `parent` is undefined) by exact title. */
  public findFolderByTitle(title: string, parent?: SNFolder): SNFolder | undefined {
    return this.folders.find(
      (folder) => folder.title === title && (parent ? folder.parentId === parent.uuid : !folder.parentId),
    )
  }

  /**
   * Standard Red Notes: resolve a folder path (ordered list of folder-name
   * segments) into the deepest folder, creating any missing folders along the way
   * and reusing existing folders with matching titles. Returns undefined for an
   * empty path. Used to recreate a dropped/selected directory tree.
   */
  public async ensureFolderPath(segments: string[]): Promise<SNFolder | undefined> {
    let parent: SNFolder | undefined
    for (const segment of segments) {
      const title = segment.trim()
      if (title.length === 0) {
        continue
      }
      const existing = this.findFolderByTitle(title, parent)
      parent = existing ?? (await this.createFolderReturning(title, parent))
      if (!parent) {
        return undefined
      }
    }
    return parent
  }

  /** Begin the inline-create flow for a new root folder (renders an editable template row). */
  public createNewFolderTemplate(): void {
    if (this.editingFolder_ && this.items.isTemplateItem(this.editingFolder_)) {
      return
    }
    const template = this.items.createTemplateItem<FolderContent, SNFolder>(FolderContentType, {
      title: '',
    } as unknown as FolderContent)
    runInAction(() => {
      this.selectedLocation = 'folders'
      this.editingFolder_ = template
    })
  }

  public setFolderExpanded(folder: SNFolder, expanded: boolean): void {
    if (folder.expanded === expanded) {
      return
    }
    this._changeAndSaveItem
      .execute<FolderMutator>(folder, (mutator) => {
        mutator.expanded = expanded
      })
      .catch(console.error)
  }

  public setFolderIcon(folder: SNFolder, icon: VectorIconNameOrEmoji): void {
    this._changeAndSaveItem
      .execute<FolderMutator>(folder, (mutator) => {
        mutator.iconString = icon as string
      })
      .catch(console.error)
  }

  public setFolderColor(folder: SNFolder, color: string | undefined): void {
    this._changeAndSaveItem
      .execute<FolderMutator>(folder, (mutator) => {
        mutator.color = color
      })
      .catch(console.error)
  }

  public async renameFolder(folder: SNFolder, newTitle: string): Promise<void> {
    const trimmed = newTitle.trim()
    if (trimmed.length === 0 || trimmed === folder.title) {
      return
    }
    await this._changeAndSaveItem.execute<FolderMutator>(folder, (mutator) => {
      mutator.title = trimmed
    })
  }

  /** Re-parent a folder under another folder, or to the root when `parent` is undefined. */
  public async assignFolderParent(folderUuid: string, parentUuid: string | undefined): Promise<void> {
    const folder = this.items.findItem<SNFolder>(folderUuid)
    if (!folder) {
      return
    }

    if (folder.parentId === parentUuid) {
      return
    }

    // Prevent cycles: a folder cannot become a descendant of itself.
    if (parentUuid) {
      let cursor: SNFolder | undefined = this.folders.find((f) => f.uuid === parentUuid)
      while (cursor) {
        if (cursor.uuid === folderUuid) {
          return
        }
        cursor = cursor.parentId ? this.folders.find((f) => f.uuid === cursor?.parentId) : undefined
      }
    }

    const parent = parentUuid ? this.items.findItem<SNFolder>(parentUuid) : undefined

    await this.mutator.changeItem<FolderMutator>(folder, (mutator) => {
      if (parent) {
        mutator.makeChildOf(parent)
      } else {
        mutator.unsetParent()
      }
    })

    await this.sync.sync()
  }

  public async removeFolder(folder: SNFolder, userTriggered: boolean): Promise<void> {
    let shouldDelete = !userTriggered
    if (userTriggered) {
      shouldDelete = await confirmDialog({
        title: StringUtils.deleteTag(folder.title),
        text: STRING_DELETE_TAG,
        confirmButtonStyle: 'danger',
      })
    }
    if (!shouldDelete) {
      return
    }

    // Re-parent any direct children to this folder's parent so they are not orphaned.
    const parent = folder.parentId ? this.items.findItem<SNFolder>(folder.parentId) : undefined
    const children = this.folders.filter((candidate) => candidate.parentId === folder.uuid)
    for (const child of children) {
      await this.mutator.changeItem<FolderMutator>(child, (mutator) => {
        if (parent) {
          mutator.makeChildOf(parent)
        } else {
          mutator.unsetParent()
        }
      })
    }

    await this.mutator.deleteItem(folder)
    await this.sync.sync()

    if (this.selectedUuid === folder.uuid) {
      await this.setSelectedTag(this.smartViews[0], 'views')
    }
  }

  private folderMigrationStarted = false

  private async runFolderMigrationIfNeeded(): Promise<void> {
    // Re-entrancy guard. This runs from the folder streamItems callback, and the
    // migration below CREATES folders — each insert re-fires that callback and
    // re-enters this method while the localStorage flag is still unset and the legacy
    // folder-tags still exist, duplicating folders nonstop. Set an in-memory guard
    // SYNCHRONOUSLY (before any await) so re-entrant calls bail out immediately. A
    // fresh page load (new controller instance) still retries if a prior run failed
    // before persisting the flag.
    if (this.folderMigrationStarted) {
      return
    }
    this.folderMigrationStarted = true

    const MIGRATION_FLAG = 'srn_folders_migrated_v1'
    try {
      if (typeof localStorage === 'undefined' || localStorage.getItem(MIGRATION_FLAG)) {
        return
      }
    } catch {
      return
    }

    const legacyFolderTags = this.items
      .getItems<SNTag>(ContentType.TYPES.Tag)
      .filter((tag) => (tag as unknown as { isFolder?: boolean }).isFolder === true)

    if (legacyFolderTags.length === 0) {
      try {
        localStorage.setItem(MIGRATION_FLAG, '1')
      } catch {
        /* ignore */
      }
      return
    }

    // Map old folder-tag uuid -> newly created SNFolder, so we can rebuild parentage.
    const tagUuidToNewFolder = new Map<string, SNFolder>()
    let migratedAny = false

    try {
      for (const tag of legacyFolderTags) {
        const template = this.items.createTemplateItem<FolderContent, SNFolder>(FolderContentType, {
          title: tag.title,
          iconString: tag.iconString,
          expanded: tag.expanded,
          color: tag.color,
        } as unknown as FolderContent)
        const created = await this.mutator.insertItem<SNFolder>(template)
        tagUuidToNewFolder.set(tag.uuid, created)

        const referencedNoteUuids = tag.noteReferences.map((ref) => ref.uuid)
        if (referencedNoteUuids.length > 0) {
          await this.mutator.changeItem<FolderMutator>(created, (mutator) => {
            for (const noteUuid of referencedNoteUuids) {
              const note = this.items.findItem<SNNote>(noteUuid)
              if (note) {
                mutator.addNote(note)
              }
            }
          })
        }
        migratedAny = true
      }

      // Rebuild parent relationships among the migrated folders.
      for (const tag of legacyFolderTags) {
        const parentTag = this.items.getTagParent(tag)
        if (!parentTag) {
          continue
        }
        const newChild = tagUuidToNewFolder.get(tag.uuid)
        const newParent = tagUuidToNewFolder.get(parentTag.uuid)
        if (newChild && newParent) {
          await this.mutator.changeItem<FolderMutator>(newChild, (mutator) => {
            mutator.makeChildOf(newParent)
          })
        }
      }

      // Only delete the old folder-tags once every one was successfully recreated.
      const allMigrated = legacyFolderTags.every((tag) => tagUuidToNewFolder.has(tag.uuid))
      if (allMigrated) {
        for (const tag of legacyFolderTags) {
          await this.mutator.deleteItem(tag)
        }
      } else {
        console.warn('Folder migration: not all folder-tags were recreated; leaving originals intact.')
      }

      await this.sync.sync()
      this.reloadFolders()
    } catch (error) {
      console.error('Folder migration failed; leaving legacy folder-tags intact.', error)
      // Do not set the flag so we can retry on a future run; avoid data loss.
      return
    }

    if (migratedAny || legacyFolderTags.length === 0) {
      try {
        localStorage.setItem(MIGRATION_FLAG, '1')
      } catch {
        /* ignore */
      }
    }
  }

  public getNotesCount(tag: SNTag): number {
    return this.tagsCountsState.counts[tag.uuid] || 0
  }

  getChildren(tag: SNTag): SNTag[] {
    if (this.items.isTemplateItem(tag)) {
      return []
    }

    if (this.isSearching) {
      return []
    }

    const children = this.items.getTagChildren(tag)

    const childrenUuids = children.map((childTag) => childTag.uuid)
    const childrenTags = this.tags.filter((tag) => childrenUuids.includes(tag.uuid))
    return this.applyCustomOrder(childrenTags, this.customTagsOrder)
  }

  isValidTagParent(parent: SNTag, tag: SNTag): boolean {
    return this.items.isValidTagParent(parent, tag)
  }

  public hasParent(tagUuid: UuidString): boolean {
    const item = this.items.findItem(tagUuid)
    return !!item && !!(item as SNTag).parentId
  }

  public async assignParent(tagUuid: string, futureParentUuid: string | undefined): Promise<void> {
    const tag = this.items.findItem(tagUuid) as SNTag

    const currentParent = this.items.getTagParent(tag)
    const currentParentUuid = currentParent?.uuid

    if (currentParentUuid === futureParentUuid) {
      return
    }

    const futureParent = futureParentUuid && (this.items.findItem(futureParentUuid) as SNTag)

    if (!futureParent) {
      const futureSiblings = rootTags(this.items)
      if (!isValidFutureSiblings(this.alerts, futureSiblings, tag)) {
        return
      }
      await this.mutator.unsetTagParent(tag)
    } else {
      const futureSiblings = this.items.getTagChildren(futureParent)
      if (!isValidFutureSiblings(this.alerts, futureSiblings, tag)) {
        return
      }
      await this.mutator.setTagParent(futureParent, tag)
    }

    await this.sync.sync()
  }

  get rootTags(): SNTag[] {
    return this.tags.filter((tag) => !this.items.getDisplayableTagParent(tag))
  }

  get tagsCount(): number {
    return this.tags.length
  }

  setAllNotesCount(allNotesCount: number) {
    this.allNotesCount_ = allNotesCount
  }

  setAllFilesCount(allFilesCount: number) {
    this.allFilesCount_ = allFilesCount
  }

  public get allFilesCount(): number {
    return this.allFilesCount_
  }

  public get allNotesCount(): number {
    return this.allNotesCount_
  }

  public get previouslySelected(): AnyTag | undefined {
    return this.previouslySelected_
  }

  public get selected(): AnyTag | undefined {
    return this.selected_
  }

  public async setPanelWidthForTag(tag: SNTag, width: number): Promise<void> {
    await this._changeAndSaveItem.execute<TagMutator>(tag, (mutator) => {
      mutator.preferences = {
        ...mutator.preferences,
        panelWidth: width,
      }
    })
  }

  public async setSelectedTag(
    tag: AnyTag | undefined,
    location: TagListSectionType,
    options?: { userTriggered: boolean; scrollIntoView?: boolean },
  ) {
    const { userTriggered = false, scrollIntoView = false } = options || {}
    if (tag && tag.conflictOf) {
      this._changeAndSaveItem
        .execute(tag, (mutator) => {
          mutator.conflictOf = undefined
        })
        .catch(console.error)
    }

    if (tag && (this.isTagFilesView(tag) || this.tagUsesTableView(tag))) {
      this.paneController.setPaneLayout(PaneLayout.TableView)
    } else if (userTriggered) {
      this.paneController.setPaneLayout(PaneLayout.ItemSelection)
    }

    this.previouslySelected_ = this.selected_

    await runInAction(async () => {
      this.setSelectedTagInstance(tag)
      this.selectedLocation = location

      if (tag && this.items.isTemplateItem(tag)) {
        return
      }

      if (tag) {
        this.recents.add(tag.uuid)
      }

      await this.eventBus.publishSync(
        {
          type: CrossControllerEvent.TagChanged,
          payload: { tag, previousTag: this.previouslySelected_, userTriggered: userTriggered },
        },
        InternalEventPublishStrategy.SEQUENCE,
      )
      if (userTriggered && scrollIntoView) {
        this.tagToScrollIntoView = tag
      }
    })
  }

  public async selectHomeNavigationView(): Promise<void> {
    await this.setSelectedTag(this.homeNavigationView, 'views')
  }

  public async selectFilesView() {
    await this.setSelectedTag(this.filesNavigationView, 'views')
  }

  get homeNavigationView(): SmartView {
    return this.smartViews[0]
  }

  get filesNavigationView(): SmartView {
    return this.smartViews.find(this.isTagFilesView) as SmartView
  }

  private setSelectedTagInstance(tag: AnyTag | undefined): void {
    runInAction(() => {
      this.selected_ = tag
      this.selectedUuid = tag ? tag.uuid : undefined
    })
  }

  public setExpanded(tag: SNTag, expanded: boolean) {
    if (tag.expanded === expanded) {
      return
    }

    this._changeAndSaveItem
      .execute<TagMutator>(tag, (mutator) => {
        mutator.expanded = expanded
      })
      .catch(console.error)
  }

  public async setFavorite(tag: SNTag, favorite: boolean) {
    return this._changeAndSaveItem
      .execute<TagMutator>(tag, (mutator) => {
        mutator.starred = favorite
      })
      .catch(console.error)
  }

  public setIcon(tag: SNTag, icon: VectorIconNameOrEmoji) {
    this._changeAndSaveItem
      .execute<TagMutator>(tag, (mutator) => {
        mutator.iconString = icon as string
      })
      .catch(console.error)
  }

  public setColor(tag: SNTag, color: string | undefined) {
    this._changeAndSaveItem
      .execute<TagMutator>(tag, (mutator) => {
        mutator.color = color
      })
      .catch(console.error)
  }

  public get editingTag(): SNTag | SmartView | undefined {
    return this.editing_
  }

  public setEditingTag(editingTag: SNTag | SmartView | undefined) {
    runInAction(() => {
      this.editing_ = editingTag
      if (this.selected !== editingTag) {
        void this.setSelectedTag(editingTag, this.selectedLocation || 'all')
      }
    })
  }

  public createNewTemplate() {
    const isAlreadyEditingATemplate = this.editing_ && this.items.isTemplateItem(this.editing_)

    if (isAlreadyEditingATemplate) {
      return
    }

    const newTag = this.items.createTemplateItem<TagContent, SNTag>(ContentType.TYPES.Tag)

    runInAction(() => {
      this.selectedLocation = 'all'
      this.editing_ = newTag
    })
  }

  public undoCreateNewTag() {
    this.editing_ = undefined
    const previousTag = this.previouslySelected_ || this.smartViews[0]
    void this.setSelectedTag(previousTag, this.selectedLocation || 'views')
  }

  public async remove(tag: SNTag | SmartView, userTriggered: boolean) {
    let shouldDelete = !userTriggered
    if (userTriggered) {
      shouldDelete = await confirmDialog({
        title: StringUtils.deleteTag(tag.title),
        text: STRING_DELETE_TAG,
        confirmButtonStyle: 'danger',
      })
    }
    if (shouldDelete) {
      this.mutator
        .deleteItem(tag)
        .then(() => this.sync.sync())
        .catch(console.error)
      await this.setSelectedTag(this.smartViews[0], 'views')
    }
  }

  public async save(tag: SNTag | SmartView, newTitle: string) {
    const isTemplateChange = this.items.isTemplateItem(tag)

    const latestVersion = isTemplateChange ? tag : this.items.findSureItem(tag.uuid)

    const hasEmptyTitle = newTitle.length === 0
    const hasNotChangedTitle = newTitle === latestVersion.title

    const siblings = latestVersion instanceof SNTag ? tagSiblings(this.items, latestVersion) : []
    const hasDuplicatedTitle = siblings.some((other) => other.title.toLowerCase() === newTitle.toLowerCase())

    runInAction(() => {
      this.editing_ = undefined
    })

    if (hasEmptyTitle || hasNotChangedTitle) {
      if (isTemplateChange) {
        this.undoCreateNewTag()
      }
      return
    }

    if (hasDuplicatedTitle) {
      if (isTemplateChange) {
        this.undoCreateNewTag()
      }
      this.alerts.alert('A tag with this name already exists.').catch(console.error)
      return
    }

    if (isTemplateChange) {
      const isSmartViewTitle = this.items.isSmartViewTitle(newTitle)

      if (isSmartViewTitle) {
        if (!this.featuresController.hasSmartViews) {
          await this.featuresController.showPremiumAlert(SMART_TAGS_FEATURE_NAME)
          return
        }
      }

      const insertedTag = await this.mutator.createTagOrSmartView<SNTag>(
        newTitle,
        this.vaultDisplayService.exclusivelyShownVault,
      )
      this.sync.sync().catch(console.error)
      runInAction(() => {
        void this.setSelectedTag(insertedTag, this.selectedLocation || 'views')
      })
    } else {
      await this._changeAndSaveItem.execute<TagMutator>(latestVersion, (mutator) => {
        mutator.title = newTitle
      })
    }
  }

  private setDisplayOptionsAndReloadTags = () => {
    this.items.setTagsAndViewsDisplayOptions({
      searchQuery: {
        query: this.searchQuery,
        includeProtectedNoteText: false,
        shouldCheckForSomeTagMatches: false,
      },
    })
    this.reloadTags()
  }

  public setSearchQuery = (query: string) => {
    this.searchQuery = query
    this.setDisplayOptionsAndReloadTags()
  }

  public get isSearching(): boolean {
    return this.searchQuery.length > 0
  }
}

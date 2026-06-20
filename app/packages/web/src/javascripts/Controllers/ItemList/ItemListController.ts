import { ListableContentItem } from '@/Components/ContentListView/Types/ListableContentItem'
import { debounce, destroyAllObjectProperties, isMobileScreen } from '@/Utils'
import { retrieve } from '@/Assistant/retrieval'
import {
  applyAiOrdering,
  DEFAULT_AI_RERANK_CANDIDATE_LIMIT,
  RerankCandidate,
} from '@/Assistant/contextualSearchRanking'
import { IndexableNote, SearchIndex } from '@/Utils/Items/Search/SearchIndex'
import { rankNotesByRelevance } from '@/Utils/Items/Search/RelevanceScore'
import {
  buildSearchPredicate,
  parseSearchQuery,
  ParsedSearchQuery,
  SearchableNote,
} from '@/Utils/Items/Search/SearchQueryParser'
import { extractPlaintextFromNoteText } from '@/Utils/NoteStats'
import {
  ApplicationEvent,
  CollectionSort,
  ContentType,
  findInArray,
  PrefKey,
  SmartView,
  SNNote,
  SNTag,
  SystemViewId,
  InternalEventHandlerInterface,
  InternalEventInterface,
  FileItem,
  WebAppEvent,
  NewNoteTitleFormat,
  useBoolean,
  isTag,
  isFile,
  isSmartView,
  isSystemView,
  NotesAndFilesDisplayControllerOptions,
  InternalEventBusInterface,
  PrefDefaults,
  ItemManagerInterface,
  PreferenceServiceInterface,
  ChangeAndSaveItem,
  DesktopManagerInterface,
  UuidString,
  ProtectionsClientInterface,
  FullyResolvedApplicationOptions,
  Uuids,
  isNote,
  ChallengeReason,
  KeyboardModifier,
  FolderContentType,
  NoteType,
} from '@standardnotes/snjs'
import { action, computed, makeObservable, observable, reaction, runInAction } from 'mobx'
import { WebDisplayOptions } from './WebDisplayOptions'
import { NavigationController } from '../Navigation/NavigationController'
import { CrossControllerEvent } from '../CrossControllerEvent'
import { SearchOptionsController } from '../SearchOptionsController'
import { formatDateAndTimeForNote } from '@/Utils/DateUtils'

import { AbstractViewController } from '../Abstract/AbstractViewController'
import { log, LoggingDomain } from '@/Logging'
import { NoteViewController } from '@/Components/NoteView/Controller/NoteViewController'
import { FileViewController } from '@/Components/NoteView/Controller/FileViewController'
import { TemplateNoteViewAutofocusBehavior } from '@/Components/NoteView/Controller/TemplateNoteViewControllerOptions'
import { ItemsReloadSource } from './ItemsReloadSource'
import { addToast, ToastType } from '@standardnotes/toast'
import {
  IsNativeMobileWeb,
  KeyboardService,
  SelectionControllerPersistableValue,
  VaultDisplayServiceEvent,
  VaultDisplayServiceInterface,
} from '@standardnotes/ui-services'
import { getDayjsFormattedString } from '@/Utils/GetDayjsFormattedString'
import { ItemGroupController } from '@/Components/NoteView/Controller/ItemGroupController'
import { Persistable } from '../Abstract/Persistable'
import { PaneController } from '../PaneController/PaneController'
import { requestCloseAllOpenModalsAndPopovers } from '@/Utils/CloseOpenModalsAndPopovers'
import { PaneLayout } from '../PaneController/PaneLayout'
import { RecentActionsState } from '../../Application/Recents'

const MinNoteCellHeight = 51.0
const DefaultListNumNotes = 20
const ElementIdScrollContainer = 'notes-scrollable'

/**
 * Standard Red Notes: how long the newly-created note's row keeps its
 * "just created" highlight, and the shared toast id used so rapid note
 * creation replaces (rather than stacks) the confirmation toast.
 */
const NoteCreatedHighlightDurationMs = 1200
const NoteCreatedToastId = 'new-note-created'

export class ItemListController
  extends AbstractViewController
  implements InternalEventHandlerInterface, Persistable<SelectionControllerPersistableValue>
{
  completedFullSync = false
  noteFilterText = ''
  notes: SNNote[] = []
  items: ListableContentItem[] = []
  notesToDisplay = 0
  pageSize = 0
  panelTitle = 'Notes'
  renderedItems: ListableContentItem[] = []
  searchSubmitted = false
  showDisplayOptionsMenu = false

  /**
   * Standard Red Notes: web-only "Relevance" sort state. Relevance ordering only
   * makes sense while a search query is active, so rather than persisting it as a
   * model CollectionSort it is tracked here as a presentation-layer flag. When
   * active (and searching) the search results are ordered by the pure relevance
   * scorer instead of by the underlying field sort.
   */
  relevanceSortActive = false

  /**
   * Standard Red Notes: AI-assisted CONTEXTUAL search state (off by default).
   * When a "Search with AI" re-rank completes, `aiContextualOrder` holds the
   * provider-returned ordering of candidate uuids (best match first) and
   * `aiContextualQuery` records the exact free-text query it was computed for.
   * The ordering is applied at the TOP of the search-ordering precedence, but
   * ONLY while the current free-text query still matches `aiContextualQuery` — so
   * it never lingers onto a different search and never changes behavior when the
   * feature is unused. `aiContextualLoading` drives the action's spinner.
   */
  aiContextualOrder: string[] | null = null
  aiContextualQuery: string | null = null
  aiContextualLoading = false

  /**
   * Standard Red Notes: when true, the free-text portion of the advanced search
   * query is matched case-sensitively. Toggled from the advanced-search options
   * panel. Default false (the historical behavior).
   */
  searchCaseSensitive = false

  displayOptions: NotesAndFilesDisplayControllerOptions = {
    sortBy: CollectionSort.CreatedAt,
    sortDirection: 'dsc',
    includePinned: true,
    includeArchived: false,
    includeTrashed: false,
    includeProtected: true,
  }
  private keepActiveItemOpenUuid: UuidString | undefined
  webDisplayOptions: WebDisplayOptions = {
    hideTags: true,
    hideDate: false,
    hideNotePreview: false,
    hideEditorIcon: false,
  }
  isTableViewEnabled = false
  private reloadItemsPromise?: Promise<unknown>

  /**
   * Client-side full-text search index over decrypted notes. Built lazily the
   * first time the index path is used while enabled, then kept fresh
   * incrementally from the note item-stream. A no-op (search returns null →
   * substring fallback) when the SearchIndexEnabled pref is off.
   */
  private searchIndex = new SearchIndex()
  private searchIndexCacheSize = 50
  /** Coalesced buffer of pending incremental index updates from the item stream. */
  private pendingIndexChanges: Map<string, IndexableNote> = new Map()
  private pendingIndexRemovals: Set<string> = new Set()
  private flushIndexUpdates = debounce(() => {
    if (!this.searchIndex.isBuilt) {
      this.pendingIndexChanges.clear()
      this.pendingIndexRemovals.clear()
      return
    }
    if (this.pendingIndexChanges.size === 0 && this.pendingIndexRemovals.size === 0) {
      return
    }
    const changed = [...this.pendingIndexChanges.values()]
    const removed = [...this.pendingIndexRemovals]
    this.pendingIndexChanges.clear()
    this.pendingIndexRemovals.clear()
    this.searchIndex.updateMany(changed, removed)
  }, 250)

  lastSelectedItem: ListableContentItem | undefined
  selectedUuids: Set<UuidString> = observable(new Set<UuidString>())
  selectedItems: Record<UuidString, ListableContentItem> = {}

  isMultipleSelectionMode = false

  /**
   * Standard Red Notes: uuid of the most recently user-created note. Set briefly
   * (NoteCreatedHighlightDurationMs) so the list cell can flash a "just created"
   * highlight, then cleared. Only set for explicit user-initiated creation, never
   * for placeholder/daily/auto creation.
   */
  recentlyCreatedNoteUuid: UuidString | undefined = undefined
  private recentlyCreatedNoteTimeout: ReturnType<typeof setTimeout> | undefined = undefined

  override deinit() {
    super.deinit()
    if (this.recentlyCreatedNoteTimeout) {
      clearTimeout(this.recentlyCreatedNoteTimeout)
    }
    ;(this.noteFilterText as unknown) = undefined
    ;(this.notes as unknown) = undefined
    ;(this.renderedItems as unknown) = undefined
    ;(this.navigationController as unknown) = undefined
    ;(this.searchOptionsController as unknown) = undefined
    ;(window.onresize as unknown) = undefined

    destroyAllObjectProperties(this)
  }

  constructor(
    private keyboardService: KeyboardService,
    private paneController: PaneController,
    private navigationController: NavigationController,
    private searchOptionsController: SearchOptionsController,
    private itemManager: ItemManagerInterface,
    private preferences: PreferenceServiceInterface,
    private itemControllerGroup: ItemGroupController,
    private vaultDisplayService: VaultDisplayServiceInterface,
    private desktopManager: DesktopManagerInterface | undefined,
    private protections: ProtectionsClientInterface,
    private options: FullyResolvedApplicationOptions,
    private _isNativeMobileWeb: IsNativeMobileWeb,
    private _changeAndSaveItem: ChangeAndSaveItem,
    private recents: RecentActionsState,
    eventBus: InternalEventBusInterface,
  ) {
    super(eventBus)

    makeObservable(this, {
      completedFullSync: observable,
      displayOptions: observable.struct,
      webDisplayOptions: observable.struct,
      noteFilterText: observable,
      notes: observable,
      notesToDisplay: observable,
      panelTitle: observable,
      items: observable,
      renderedItems: observable,
      showDisplayOptionsMenu: observable,
      relevanceSortActive: observable,
      aiContextualOrder: observable,
      aiContextualQuery: observable,
      aiContextualLoading: observable,
      searchCaseSensitive: observable,

      reloadItems: action,
      setRelevanceSortActive: action,
      setAiContextualOrder: action,
      clearAiContextualOrder: action,
      setAiContextualLoading: action,
      setSearchCaseSensitive: action,
      reloadPanelTitle: action,
      reloadDisplayPreferences: action,
      resetPagination: action,
      setCompletedFullSync: action,
      setNoteFilterText: action,
      setShowDisplayOptionsMenu: action,
      onFilterEnter: action,
      handleFilterTextChanged: action,

      optionsSubtitle: computed,
      activeControllerItem: computed,
      isRelevanceSortAvailable: computed,
      parsedSearchQuery: computed,

      selectedUuids: observable,
      selectedItems: observable,

      selectedItemsCount: computed,
      selectedFiles: computed,
      selectedFilesCount: computed,
      firstSelectedItem: computed,

      selectItem: action,
      setSelectedUuids: action,
      setSelectedItems: action,

      hydrateFromPersistedValue: action,

      isMultipleSelectionMode: observable,
      enableMultipleSelectionMode: action,
      cancelMultipleSelection: action,

      recentlyCreatedNoteUuid: observable,
      flashNoteCreated: action,
      clearRecentlyCreatedNote: action,
    })

    eventBus.addEventHandler(this, CrossControllerEvent.TagChanged)
    eventBus.addEventHandler(this, CrossControllerEvent.ActiveEditorChanged)
    eventBus.addEventHandler(this, VaultDisplayServiceEvent.VaultDisplayOptionsChanged)

    this.resetPagination()

    this.disposers.push(
      itemManager.streamItems<SNNote>(
        [ContentType.TYPES.Note, ContentType.TYPES.File],
        ({ changed, inserted, removed }) => {
          this.collectIndexUpdates(changed, inserted, removed)
          void this.reloadItems(ItemsReloadSource.ItemStream)
        },
      ),
    )

    this.disposers.push(
      itemManager.streamItems<SNTag>(
        [ContentType.TYPES.Tag, ContentType.TYPES.SmartView],
        async ({ changed, inserted }) => {
          const tags = [...changed, ...inserted]

          const { didReloadItems } = await this.reloadDisplayPreferences({ userTriggered: false })
          if (!didReloadItems) {
            /** A tag could have changed its relationships, so we need to reload the filter */
            this.reloadNotesDisplayOptions()
            void this.reloadItems(ItemsReloadSource.ItemStream)
          }

          if (
            this.navigationController.selected &&
            findInArray(tags, 'uuid', this.navigationController.selected.uuid)
          ) {
            /** Tag title could have changed */
            this.reloadPanelTitle()
          }
        },
      ),
    )

    this.disposers.push(
      itemManager.streamItems(FolderContentType, () => {
        /** A folder's note references could have changed, so reload the filter if one is selected. */
        if (this.navigationController.selectedFolder) {
          this.reloadNotesDisplayOptions()
          void this.reloadItems(ItemsReloadSource.ItemStream)
        }
      }),
    )

    eventBus.addEventHandler(this, ApplicationEvent.PreferencesChanged)
    eventBus.addEventHandler(this, ApplicationEvent.SignedIn)
    eventBus.addEventHandler(this, ApplicationEvent.CompletedFullSync)
    eventBus.addEventHandler(this, WebAppEvent.EditorDidFocus)

    this.disposers.push(
      reaction(
        () => [
          this.searchOptionsController.includeProtectedContents,
          this.searchOptionsController.includeArchived,
          this.searchOptionsController.includeTrashed,
        ],
        () => {
          this.reloadNotesDisplayOptions()
          void this.reloadItems(ItemsReloadSource.DisplayOptionsChange)
        },
      ),
    )

    this.disposers.push(
      reaction(
        () => this.selectedUuids,
        () => {
          eventBus.publish({
            type: CrossControllerEvent.RequestValuePersistence,
            payload: undefined,
          })
        },
      ),
    )

    this.disposers.push(
      this.itemManager.streamItems<SNNote | FileItem>(
        [ContentType.TYPES.Note, ContentType.TYPES.File],
        ({ changed, inserted, removed }) => {
          runInAction(() => {
            for (const removedItem of removed) {
              this.removeSelectedItem(removedItem.uuid)
            }

            for (const item of [...changed, ...inserted]) {
              if (this.selectedItems[item.uuid]) {
                this.selectedItems[item.uuid] = item
              }
            }
          })
        },
      ),
    )

    this.disposers.push(
      reaction(
        () => this.selectedItemsCount,
        (count) => {
          const hasNoSelectedItem = count === 0
          if (hasNoSelectedItem) {
            this.cancelMultipleSelection()
          }
        },
      ),
    )

    window.onresize = debounce(() => {
      this.resetPagination(true)
    }, 100)
  }

  getPersistableValue = (): SelectionControllerPersistableValue => {
    return {
      selectedUuids: Array.from(this.selectedUuids),
    }
  }

  hydrateFromPersistedValue = (state: SelectionControllerPersistableValue | undefined): void => {
    if (!state) {
      return
    }

    if (!this.selectedUuids.size && state.selectedUuids.length > 0) {
      if (!this.options.allowNoteSelectionStatePersistence) {
        const items = this.itemManager.findItems(state.selectedUuids).filter((item) => !isNote(item))
        void this.selectUuids(Uuids(items))
      } else {
        void this.selectUuids(state.selectedUuids)
      }
    }
  }

  async handleEvent(event: InternalEventInterface): Promise<void> {
    switch (event.type) {
      case CrossControllerEvent.TagChanged: {
        const payload = event.payload as { userTriggered: boolean }
        await this.handleTagChange(payload.userTriggered)
        break
      }

      case CrossControllerEvent.ActiveEditorChanged: {
        await this.handleEditorChange()
        break
      }

      case VaultDisplayServiceEvent.VaultDisplayOptionsChanged: {
        void this.reloadItems(ItemsReloadSource.DisplayOptionsChange)
        break
      }

      case ApplicationEvent.PreferencesChanged: {
        void this.reloadDisplayPreferences({ userTriggered: false })
        break
      }

      case WebAppEvent.EditorDidFocus: {
        this.setShowDisplayOptionsMenu(false)
        break
      }

      case ApplicationEvent.SignedIn: {
        this.itemControllerGroup.closeAllItemControllers()
        void this.selectFirstItem()
        this.setCompletedFullSync(false)
        break
      }

      case ApplicationEvent.CompletedFullSync: {
        if (!this.completedFullSync) {
          void this.reloadItems(ItemsReloadSource.SyncEvent).then(() => {
            if (
              this.notes.length === 0 &&
              this.navigationController.selected instanceof SmartView &&
              this.navigationController.selected.uuid === SystemViewId.AllNotes &&
              this.noteFilterText === '' &&
              !this.getActiveItemController()
            ) {
              this.createPlaceholderNote()?.catch(console.error)
            }
          })
          this.setCompletedFullSync(true)
          break
        }
      }
    }
  }

  public get listLength() {
    return this.renderedItems.length
  }

  public getActiveItemController(): NoteViewController | FileViewController | undefined {
    return this.itemControllerGroup.activeItemViewController
  }

  public get activeControllerItem() {
    return this.getActiveItemController()?.item
  }

  async openNote(uuid: string): Promise<void> {
    if (this.activeControllerItem?.uuid === uuid) {
      return
    }

    const note = this.itemManager.findItem<SNNote>(uuid)
    if (!note) {
      console.warn('Tried accessing a non-existant note of UUID ' + uuid)
      return
    }

    await this.itemControllerGroup.createItemController({ note })

    await this.publishCrossControllerEventSync(CrossControllerEvent.ActiveEditorChanged)
  }

  /**
   * Opens a note as an additional tile in the tiled multi-note editor without
   * closing any currently open tiles. If no uuid is provided the currently
   * highlighted-in-list note (firstSelectedItem) is used.
   */
  async openNoteInNewTile(uuid?: string): Promise<void> {
    const targetUuid = uuid ?? this.firstSelectedItem?.uuid

    if (!targetUuid) {
      return
    }

    const alreadyOpen = this.itemControllerGroup.itemControllers.some(
      (controller) => controller.item.uuid === targetUuid,
    )
    if (alreadyOpen) {
      return
    }

    const note = this.itemManager.findItem<SNNote>(targetUuid)
    if (!note) {
      console.warn('Tried opening a non-existant note in new tile of UUID ' + targetUuid)
      return
    }

    await this.itemControllerGroup.createItemController({ note, openInNewTile: true })

    await this.publishCrossControllerEventSync(CrossControllerEvent.ActiveEditorChanged)
  }

  async openFile(fileUuid: string): Promise<void> {
    if (this.getActiveItemController()?.item.uuid === fileUuid) {
      return
    }

    const file = this.itemManager.findItem<FileItem>(fileUuid)
    if (!file) {
      console.warn('Tried accessing a non-existant file of UUID ' + fileUuid)
      return
    }

    await this.itemControllerGroup.createItemController({ file })
  }

  setCompletedFullSync = (completed: boolean) => {
    this.completedFullSync = completed
  }

  setShowDisplayOptionsMenu = (enabled: boolean) => {
    this.showDisplayOptionsMenu = enabled
  }

  get isFiltering(): boolean {
    return !!this.noteFilterText && this.noteFilterText.length > 0
  }

  /**
   * Standard Red Notes: the current search bar text parsed into structured
   * operators + free text. Recomputed only when noteFilterText changes. Operators
   * (tag:, type:, is:, in:, created:, updated:, negation, quoted phrases) are
   * applied as a web-side predicate; the residual free text is what the existing
   * model substring search / relevance / index path operates on.
   */
  get parsedSearchQuery(): ParsedSearchQuery {
    return parseSearchQuery(this.noteFilterText)
  }

  /**
   * The portion of the search text that should drive the existing full-text
   * match. Equal to the whole query when no operators are used (preserving the
   * original behavior); otherwise just the free-text remainder.
   */
  private get searchFreeText(): string {
    return this.parsedSearchQuery.freeText
  }

  setSearchCaseSensitive = (caseSensitive: boolean): void => {
    if (this.searchCaseSensitive === caseSensitive) {
      return
    }
    this.searchCaseSensitive = caseSensitive
    if (this.isFiltering) {
      this.reloadNotesDisplayOptions()
      void this.reloadItems(ItemsReloadSource.FilterTextChange)
    }
  }

  /** Map a displayable note/file into the shape the search predicate consumes. */
  private toSearchableNote(item: ListableContentItem): SearchableNote {
    const noteLike = item as unknown as {
      title?: string
      text?: string
      noteType?: NoteType
      editorIdentifier?: string
      protected?: boolean
      pinned?: boolean
      archived?: boolean
      starred?: boolean
      trashed?: boolean
      locked?: boolean
    }
    const rawText = noteLike.text ?? ''
    const text = rawText.length > 0 ? extractPlaintextFromNoteText(rawText, noteLike.noteType) : ''
    const tagTitles = this.itemManager.getSortedTagsForItem(item).map((tag) => tag.title)
    // Prefer the editor identifier's trailing segment (e.g. "code" from
    // org.standardnotes.code) so `editor:code` works even when noteType is unset,
    // falling back to the structured NoteType.
    const editorType = noteLike.editorIdentifier?.split('.').pop()
    const noteType = noteLike.noteType ?? editorType

    return {
      title: noteLike.title ?? '',
      text,
      noteType,
      tagTitles,
      protected: noteLike.protected ?? false,
      pinned: noteLike.pinned ?? false,
      archived: noteLike.archived ?? false,
      starred: noteLike.starred ?? false,
      trashed: noteLike.trashed ?? false,
      locked: noteLike.locked ?? false,
      createdAt: item.created_at?.getTime() ?? 0,
      updatedAt: (item.userModifiedDate ?? item.created_at)?.getTime() ?? 0,
    }
  }

  /**
   * Standard Red Notes: apply the advanced-search operator predicate (tag:, type:,
   * is:, in:, created:/updated:, negation, quoted phrases) to the already
   * model-filtered items. When the query has no operators this is a no-op, so the
   * original full-text behavior is preserved exactly. The free-text part of the
   * query is still enforced by the model substring filter; here we additionally
   * enforce operator constraints and any negated / scoped (`in:`) free text.
   */
  private applyOperatorFilter(items: ListableContentItem[]): ListableContentItem[] {
    const parsed = this.parsedSearchQuery
    const needsPredicate =
      parsed.hasOperators ||
      parsed.freeTextTerms.some((term) => term.negated) ||
      this.searchCaseSensitive
    if (!needsPredicate || items.length === 0) {
      return items
    }

    const predicate = buildSearchPredicate(parsed, { caseSensitive: this.searchCaseSensitive })
    return items.filter((item) => predicate(this.toSearchableNote(item)))
  }

  reloadPanelTitle = () => {
    let title = this.panelTitle

    if (this.isFiltering) {
      const resultCount = this.items.length
      title = `${resultCount} search results`
    } else if (this.navigationController.selected) {
      title = `${this.navigationController.selected.title}`
    }

    this.panelTitle = title
  }

  reloadItems = async (source: ItemsReloadSource): Promise<void> => {
    if (this.reloadItemsPromise) {
      await this.reloadItemsPromise
    }

    this.reloadItemsPromise = this.performReloadItems(source)

    await this.reloadItemsPromise
  }

  private async performReloadItems(source: ItemsReloadSource) {
    const tag = this.navigationController.selected
    if (!tag) {
      return
    }

    const notes = this.itemManager.getDisplayableNotes()

    const items = this.applySearchOrdering(
      this.applyOperatorFilter(this.itemManager.getDisplayableNotesAndFiles()),
    )

    const renderedItems = items.slice(0, this.notesToDisplay)

    runInAction(() => {
      this.notes = notes
      this.items = items
      this.renderedItems = renderedItems
    })

    await this.recomputeSelectionAfterItemsReload(source)

    this.reloadPanelTitle()
  }

  /**
   * Optional AI-powered search ranking (off by default). When enabled and a
   * search query is active, reorder the already substring-filtered items by
   * local BM25 relevance so the most pertinent notes surface first. Runs entirely
   * client-side over decrypted items, so end-to-end encryption is preserved.
   */
  private applyAiSearchRanking(items: ListableContentItem[]): ListableContentItem[] {
    const query = this.searchFreeText
    if (!query || query.length === 0 || items.length === 0) {
      return items
    }
    const enabled = this.preferences.getValue(
      PrefKey.AiPoweredSearchEnabled,
      PrefDefaults[PrefKey.AiPoweredSearchEnabled],
    )
    if (!enabled) {
      return items
    }

    const docs = items.map((item) => ({
      uuid: item.uuid,
      title: item.title ?? '',
      text: (item as { text?: string }).text ?? '',
    }))
    const hits = retrieve(docs, query, { perNote: true, limit: docs.length })
    if (hits.length === 0) {
      return items
    }

    const rankByUuid = new Map<string, number>()
    hits.forEach((hit, index) => rankByUuid.set(hit.noteUuid, index))

    // Stable sort: ranked items in relevance order; everything else keeps its
    // existing relative order after them.
    return [...items].sort((a, b) => {
      const rankA = rankByUuid.has(a.uuid) ? (rankByUuid.get(a.uuid) as number) : Number.MAX_SAFE_INTEGER
      const rankB = rankByUuid.has(b.uuid) ? (rankByUuid.get(b.uuid) as number) : Number.MAX_SAFE_INTEGER
      return rankA - rankB
    })
  }

  /**
   * Map a note/file item to the shape the search index consumes. Files have no
   * text body; only their title is indexable.
   *
   * Super notes store Lexical editor-state JSON in `text`; indexing that raw JSON
   * would let the index match on internal node keys instead of the readable
   * prose. We run {@link extractPlaintextFromNoteText} so Super notes are indexed
   * (and therefore searched/ranked) by their visible text. Plain notes pass the
   * text through unchanged.
   */
  private toIndexableNote(item: { uuid: string; title?: string; text?: string; noteType?: NoteType }): IndexableNote {
    const rawText = item.text ?? ''
    const text = rawText.length > 0 ? extractPlaintextFromNoteText(rawText, item.noteType) : ''
    return { uuid: item.uuid, title: item.title ?? '', text }
  }

  /** Buffer item-stream changes for a debounced, coalesced incremental index update. */
  private collectIndexUpdates(
    changed: { uuid: string; title?: string; text?: string; noteType?: NoteType }[],
    inserted: { uuid: string; title?: string; text?: string; noteType?: NoteType }[],
    removed: { uuid: string }[],
  ): void {
    if (!this.searchIndex.isBuilt) {
      return
    }
    for (const item of removed) {
      this.pendingIndexChanges.delete(item.uuid)
      this.pendingIndexRemovals.add(item.uuid)
    }
    for (const item of [...changed, ...inserted]) {
      this.pendingIndexRemovals.delete(item.uuid)
      this.pendingIndexChanges.set(item.uuid, this.toIndexableNote(item))
    }
    this.flushIndexUpdates()
  }

  /** Whether the configurable client-side search index path is enabled. */
  private get isSearchIndexEnabled(): boolean {
    return this.preferences.getValue(PrefKey.SearchIndexEnabled, PrefDefaults[PrefKey.SearchIndexEnabled])
  }

  /**
   * Decide how the already substring-filtered items are ordered for the current
   * query. Precedence:
   *  1. Fast inverted-index path (SearchIndexEnabled) — reorders by indexed
   *     relevance, with the AI/BM25 ranking applied when AiPoweredSearchEnabled.
   *  2. AI-powered BM25 ranking alone (AiPoweredSearchEnabled).
   *  3. Plain substring order (the existing default).
   * Falls back to substring order whenever the index can't handle the query.
   */
  private applySearchOrdering(items: ListableContentItem[]): ListableContentItem[] {
    // First run the existing algorithmic ordering (relevance → index → BM25 →
    // substring). The AI contextual re-rank is then layered ON TOP of that order,
    // so it builds on — never replaces — the algorithmic pipeline.
    const algorithmic = this.applyAlgorithmicOrdering(items)
    return this.applyContextualAiOrdering(algorithmic)
  }

  /** The existing (non-AI-provider) ordering precedence. */
  private applyAlgorithmicOrdering(items: ListableContentItem[]): ListableContentItem[] {
    const relevance = this.applyRelevanceOrdering(items)
    if (relevance) {
      return relevance
    }
    const indexed = this.applySearchIndexOrdering(items)
    if (indexed) {
      return indexed
    }
    return this.applyAiSearchRanking(items)
  }

  /**
   * Standard Red Notes: optional AI-assisted CONTEXTUAL re-ranking, layered on top
   * of the algorithmic order. A no-op (returns the input unchanged) unless a
   * "Search with AI" re-rank has completed FOR THE CURRENT free-text query — so
   * the default-off path, and any query other than the one the user explicitly ran
   * AI search on, behaves exactly like the algorithmic ordering.
   *
   * The stored ordering covers only the bounded top-N candidates that were sent to
   * the provider; applyAiOrdering places those first (in the model's order) and
   * keeps every other item in its existing relative position, so nothing the
   * algorithmic search surfaced disappears.
   */
  private applyContextualAiOrdering(items: ListableContentItem[]): ListableContentItem[] {
    if (!this.aiContextualOrder || this.aiContextualOrder.length === 0) {
      return items
    }
    if (this.aiContextualQuery !== this.searchFreeText) {
      return items
    }
    return applyAiOrdering(items, this.aiContextualOrder)
  }

  /**
   * The bounded set of candidates the AI re-rank should operate on: the current
   * top-N algorithmically-ordered items (titles + plain-text bodies), capped to
   * keep exposure small. The React "Search with AI" action reads this, sends it to
   * the provider, and hands the resulting order back via setAiContextualOrder.
   */
  getAiRerankCandidates(limit = DEFAULT_AI_RERANK_CANDIDATE_LIMIT): RerankCandidate[] {
    return this.items.slice(0, limit).map((item) => ({
      uuid: item.uuid,
      title: item.title ?? '',
      text: extractPlaintextFromNoteText(
        (item as { text?: string }).text ?? '',
        (item as { noteType?: NoteType }).noteType,
      ),
    }))
  }

  /** The free-text query the AI re-rank should be run for (matches what's applied). */
  get aiRerankQuery(): string {
    return this.searchFreeText
  }

  setAiContextualLoading = (loading: boolean): void => {
    this.aiContextualLoading = loading
  }

  /**
   * Store a completed AI re-rank ordering for a specific query and reorder the
   * list. Ignored if the user has since changed the query (stale result).
   */
  setAiContextualOrder = (query: string, orderedUuids: string[]): void => {
    if (query !== this.searchFreeText) {
      return
    }
    this.aiContextualQuery = query
    this.aiContextualOrder = orderedUuids
    void this.reloadItems(ItemsReloadSource.DisplayOptionsChange)
  }

  /** Drop any AI ordering (e.g. when the query changes or search is cleared). */
  clearAiContextualOrder = (): void => {
    if (this.aiContextualOrder === null && this.aiContextualQuery === null) {
      return
    }
    this.aiContextualOrder = null
    this.aiContextualQuery = null
  }

  /**
   * Standard Red Notes: highest-precedence search ordering. When the user has the
   * "Relevance" sort active and a query is present, order the already
   * substring-filtered items by the pure relevance scorer (best match first).
   *
   * Returns null (so the caller falls back to index/BM25/substring order) when
   * relevance sort is off or there is no active query. Items that score 0 for the
   * query keep their existing relative order after the scored matches, so nothing
   * the substring filter surfaced disappears.
   */
  private applyRelevanceOrdering(items: ListableContentItem[]): ListableContentItem[] | null {
    const query = this.searchFreeText
    if (!this.relevanceSortActive || !query || query.trim().length === 0 || items.length === 0) {
      return null
    }

    const scorable = items.map((item) => ({
      uuid: item.uuid,
      title: item.title ?? '',
      text: extractPlaintextFromNoteText(
        (item as { text?: string }).text ?? '',
        (item as { noteType?: NoteType }).noteType,
      ),
    }))

    const rankedUuids = rankNotesByRelevance(scorable, query)
    if (rankedUuids.length === 0) {
      return null
    }

    const rankByUuid = new Map<string, number>()
    rankedUuids.forEach((uuid, index) => rankByUuid.set(uuid, index))

    return [...items].sort((a, b) => {
      const rankA = rankByUuid.has(a.uuid) ? (rankByUuid.get(a.uuid) as number) : Number.MAX_SAFE_INTEGER
      const rankB = rankByUuid.has(b.uuid) ? (rankByUuid.get(b.uuid) as number) : Number.MAX_SAFE_INTEGER
      return rankA - rankB
    })
  }

  /**
   * Fast path: use the client-side inverted index to order/limit results.
   * Returns null (so the caller falls back to substring/BM25 behavior) when the
   * feature is off, there is no query, the query is too short, or the index has
   * nothing to say for this query.
   *
   * The index is built lazily here over the currently displayable notes the
   * first time it is needed, then kept fresh incrementally from the item stream.
   */
  private applySearchIndexOrdering(items: ListableContentItem[]): ListableContentItem[] | null {
    const query = this.searchFreeText
    if (!query || items.length === 0 || !this.isSearchIndexEnabled) {
      return null
    }

    const minLength = this.preferences.getValue(
      PrefKey.SearchMinQueryLength,
      PrefDefaults[PrefKey.SearchMinQueryLength],
    )
    if (query.trim().length < minLength) {
      return null
    }

    // Honor the configured query-cache size; recreate the index if it changed so
    // the LRU cap stays in sync with the user's preference.
    const cacheSize = this.preferences.getValue(
      PrefKey.SearchQueryCacheSize,
      PrefDefaults[PrefKey.SearchQueryCacheSize],
    )
    if (cacheSize !== this.searchIndexCacheSize) {
      this.searchIndexCacheSize = cacheSize
      this.searchIndex = new SearchIndex({ queryCacheSize: cacheSize })
    }

    this.searchIndex.ensureBuilt(() =>
      this.itemManager.getDisplayableNotes().map((note) => this.toIndexableNote(note)),
    )

    const rank = this.preferences.getValue(
      PrefKey.AiPoweredSearchEnabled,
      PrefDefaults[PrefKey.AiPoweredSearchEnabled],
    )
    const matchedUuids = this.searchIndex.search(query, { rank })
    if (matchedUuids === null) {
      // Index can't handle this query (e.g. only special chars); fall back.
      return null
    }

    // Intersect index results with the substring-filtered `items` so we never
    // surface notes the existing display-options filter excluded (tags, archived,
    // trashed, protected, vaults). This keeps correctness identical to substring
    // search while letting the index decide ordering/relevance.
    const rankByUuid = new Map<string, number>()
    matchedUuids.forEach((uuid, index) => rankByUuid.set(uuid, index))

    return [...items].sort((a, b) => {
      const rankA = rankByUuid.has(a.uuid) ? (rankByUuid.get(a.uuid) as number) : Number.MAX_SAFE_INTEGER
      const rankB = rankByUuid.has(b.uuid) ? (rankByUuid.get(b.uuid) as number) : Number.MAX_SAFE_INTEGER
      return rankA - rankB
    })
  }

  private shouldLeaveSelectionUnchanged = (activeController: NoteViewController | FileViewController | undefined) => {
    return activeController instanceof NoteViewController && activeController.isTemplateNote
  }

  /**
   * In some cases we want to keep the selected item open even if it doesn't appear in results,
   * for example if you are inside tag Foo and remove tag Foo from the note, we want to keep the note open.
   */
  private shouldCloseActiveItem = (activeItem: SNNote | FileItem | undefined, source?: ItemsReloadSource) => {
    if (source === ItemsReloadSource.UserTriggeredTagChange) {
      log(LoggingDomain.Selection, 'shouldCloseActiveItem true due to ItemsReloadSource.UserTriggeredTagChange')
      return true
    }

    const activeItemExistsInUpdatedResults = this.items.find((item) => item.uuid === activeItem?.uuid)

    const closeBecauseActiveItemIsFileAndDoesntExistInUpdatedResults =
      activeItem && isFile(activeItem) && !activeItemExistsInUpdatedResults

    if (closeBecauseActiveItemIsFileAndDoesntExistInUpdatedResults) {
      log(LoggingDomain.Selection, 'shouldCloseActiveItem closeBecauseActiveItemIsFileAndDoesntExistInUpdatedResults')
      return true
    }

    const firstItemInNewResults = this.getFirstNonProtectedItem()

    const closePreviousItemWhenSwitchingToFilesBasedView =
      firstItemInNewResults && isFile(firstItemInNewResults) && !activeItemExistsInUpdatedResults

    if (closePreviousItemWhenSwitchingToFilesBasedView) {
      log(LoggingDomain.Selection, 'shouldCloseActiveItem closePreviousItemWhenSwitchingToFilesBasedView')
      return true
    }

    const isSearching = this.noteFilterText.length > 0

    const closeBecauseActiveItemDoesntExistInCurrentSystemView =
      !activeItemExistsInUpdatedResults && !isSearching && this.navigationController.isInAnySystemView()

    if (closeBecauseActiveItemDoesntExistInCurrentSystemView) {
      if (activeItem && activeItem.uuid === this.keepActiveItemOpenUuid) {
        log(LoggingDomain.Selection, 'shouldCloseActiveItem false due to keepActiveItemOpenUuid')
        return false
      }
      log(LoggingDomain.Selection, 'shouldCloseActiveItem closePreviousItemWhenSwitchingToFilesBasedView')
      return true
    }

    log(LoggingDomain.Selection, 'shouldCloseActiveItem false')
    return false
  }

  private shouldSelectNextItemOrCreateNewNote = (activeItem: SNNote | FileItem | undefined) => {
    if (activeItem?.uuid === this.keepActiveItemOpenUuid) {
      return false
    }

    const selectedView = this.navigationController.selected

    const isActiveItemTrashed = activeItem?.trashed
    const isActiveItemArchived = activeItem?.archived

    if (isActiveItemTrashed) {
      const selectedSmartViewShowsTrashed =
        selectedView instanceof SmartView && selectedView.predicate.keypathIncludesString('trashed')

      const shouldShowTrashedNotes =
        this.navigationController.isInSystemView(SystemViewId.TrashedNotes) ||
        this.searchOptionsController.includeTrashed ||
        selectedSmartViewShowsTrashed ||
        this.displayOptions.includeTrashed

      return !shouldShowTrashedNotes
    }

    if (isActiveItemArchived) {
      const selectedSmartViewShowsArchived =
        selectedView instanceof SmartView && selectedView.predicate.keypathIncludesString('archived')

      const shouldShowArchivedNotes =
        this.navigationController.isInSystemView(SystemViewId.ArchivedNotes) ||
        this.searchOptionsController.includeArchived ||
        selectedSmartViewShowsArchived ||
        this.displayOptions.includeArchived

      return !shouldShowArchivedNotes
    }

    return false
  }

  private shouldSelectActiveItem = (activeItem: SNNote | FileItem) => {
    return !this.isItemSelected(activeItem)
  }

  shouldSelectFirstItem = (itemsReloadSource: ItemsReloadSource) => {
    if (this._isNativeMobileWeb.execute().getValue()) {
      return false
    }

    const item = this.getFirstNonProtectedItem()
    if (item && isFile(item)) {
      return false
    }

    const selectedTag = this.navigationController.selected
    const isDailyEntry = selectedTag && isTag(selectedTag) && selectedTag.isDailyEntry
    if (isDailyEntry) {
      return false
    }

    const userChangedTag = itemsReloadSource === ItemsReloadSource.UserTriggeredTagChange
    const hasNoSelectedItem = !this.selectedUuids.size

    return userChangedTag || hasNoSelectedItem
  }

  private async recomputeSelectionAfterItemsReload(itemsReloadSource: ItemsReloadSource) {
    const activeController = this.getActiveItemController()

    if (this.shouldLeaveSelectionUnchanged(activeController)) {
      log(LoggingDomain.Selection, 'Leaving selection unchanged')
      return
    }

    const activeItem = activeController?.item

    if (activeController && activeItem && this.shouldCloseActiveItem(activeItem, itemsReloadSource)) {
      this.closeItemController(activeController)

      this.deselectItem(activeItem)

      if (this.shouldSelectFirstItem(itemsReloadSource)) {
        if (this.isTableViewEnabled && !isMobileScreen()) {
          return
        }

        log(LoggingDomain.Selection, 'Selecting next item after closing active one')
        this.selectNextItem({ userTriggered: false })
      } else if (this.paneController.isInMobileView && !this.itemManager.findItem(activeItem.uuid)) {
        log(LoggingDomain.Selection, 'Navigating back to item list because active note was deleted remotely')
        void this.paneController.setPaneLayout(PaneLayout.ItemSelection)
      }
    } else if (activeItem && this.shouldSelectActiveItem(activeItem)) {
      log(LoggingDomain.Selection, 'Selecting active item')
      await this.selectItem(activeItem.uuid).catch(console.error)
    } else if (this.shouldSelectFirstItem(itemsReloadSource)) {
      await this.selectFirstItem()
    } else if (this.shouldSelectNextItemOrCreateNewNote(activeItem)) {
      await this.selectNextItemOrCreateNewNote()
    } else {
      log(LoggingDomain.Selection, 'No selection change')
    }
  }

  reloadNotesDisplayOptions = () => {
    const tag = this.navigationController.selected

    // The model substring filter only sees the free-text portion; operators
    // (tag:, is:, created:, etc.) are enforced web-side in applyOperatorFilter.
    // When no operators are present this equals the full query, preserving the
    // original behavior exactly. We lowercase to match the model's behavior, but
    // case-sensitive matching (when enabled) is enforced by the operator predicate.
    const searchText = this.searchFreeText.toLowerCase()
    // "Searching" stays keyed off the raw box text so an operator-only query
    // (e.g. `is:pinned`) still counts as an active search.
    const isSearching = this.noteFilterText.trim().length
    let includeArchived: boolean
    let includeTrashed: boolean

    if (isSearching) {
      includeArchived = this.searchOptionsController.includeArchived
      includeTrashed = this.searchOptionsController.includeTrashed
    } else {
      includeArchived = this.displayOptions.includeArchived ?? false
      includeTrashed = this.displayOptions.includeTrashed ?? false
    }

    // When the advanced query explicitly asks for archived/trashed notes
    // (`is:archived` / `is:trashed`), the model must include them so the operator
    // predicate has something to narrow down — otherwise the result would always
    // be empty since the model would have pre-excluded them.
    for (const op of this.parsedSearchQuery.operators) {
      if (op.kind === 'is' && !op.negated) {
        if (op.flag === 'archived') {
          includeArchived = true
        } else if (op.flag === 'trashed') {
          includeTrashed = true
        }
      }
    }

    const selectedFolder = this.navigationController.selectedFolder
    const isFolderSelected = selectedFolder && selectedFolder.uuid === this.navigationController.selectedUuid

    const criteria: NotesAndFilesDisplayControllerOptions = {
      sortBy: this.displayOptions.sortBy,
      sortDirection: this.displayOptions.sortDirection,
      customOrder:
        this.displayOptions.sortBy === CollectionSort.Custom
          ? this.preferences.getValue(PrefKey.CustomNotesOrder, PrefDefaults[PrefKey.CustomNotesOrder])
          : undefined,
      tags: !isFolderSelected && tag instanceof SNTag ? [tag] : [],
      views: !isFolderSelected && tag instanceof SmartView ? [tag] : [],
      folders: isFolderSelected ? [selectedFolder] : [],
      includeArchived,
      includeTrashed,
      includePinned: this.displayOptions.includePinned,
      includeProtected: this.displayOptions.includeProtected,
      searchQuery: {
        query: searchText,
        includeProtectedNoteText: this.searchOptionsController.includeProtectedContents,
      },
    }

    this.itemManager.setPrimaryItemDisplayOptions(criteria)
  }

  reloadDisplayPreferences = async ({
    userTriggered,
  }: {
    userTriggered: boolean
  }): Promise<{ didReloadItems: boolean }> => {
    const newDisplayOptions = {} as NotesAndFilesDisplayControllerOptions
    const newWebDisplayOptions = {} as WebDisplayOptions

    const selectedTag = this.navigationController.selected
    const isSystemTag = selectedTag && isSmartView(selectedTag) && isSystemView(selectedTag)
    const selectedTagPreferences = isSystemTag
      ? this.preferences.getValue(PrefKey.SystemViewPreferences)?.[selectedTag.uuid as SystemViewId]
      : selectedTag?.preferences

    this.isTableViewEnabled = Boolean(selectedTagPreferences?.useTableView)

    const currentSortBy = this.displayOptions.sortBy
    let sortBy =
      selectedTagPreferences?.sortBy ||
      this.preferences.getValue(PrefKey.SortNotesBy, PrefDefaults[PrefKey.SortNotesBy])
    if (sortBy === CollectionSort.UpdatedAt || (sortBy as string) === 'client_updated_at') {
      sortBy = CollectionSort.UpdatedAt
    }
    newDisplayOptions.sortBy = sortBy

    /**
     * Standard Red Notes: in Custom (manual) sort mode the order is driven by the
     * global CustomNotesOrder pref (an array of uuids), not by an item field.
     * Carry it so the model's display controller can order accordingly, and so a
     * drag-reorder (which rewrites the pref) reloads the list below.
     */
    newDisplayOptions.customOrder =
      sortBy === CollectionSort.Custom
        ? this.preferences.getValue(PrefKey.CustomNotesOrder, PrefDefaults[PrefKey.CustomNotesOrder])
        : undefined

    const currentSortDirection = this.displayOptions.sortDirection
    newDisplayOptions.sortDirection =
      useBoolean(
        selectedTagPreferences?.sortReverse,
        this.preferences.getValue(PrefKey.SortNotesReverse, PrefDefaults[PrefKey.SortNotesReverse]),
      ) === false
        ? 'dsc'
        : 'asc'

    newDisplayOptions.includeArchived = useBoolean(
      selectedTagPreferences?.showArchived,
      this.preferences.getValue(PrefKey.NotesShowArchived, PrefDefaults[PrefKey.NotesShowArchived]),
    )

    newDisplayOptions.includeTrashed = useBoolean(
      selectedTagPreferences?.showTrashed,
      this.preferences.getValue(PrefKey.NotesShowTrashed, PrefDefaults[PrefKey.NotesShowTrashed]),
    )

    newDisplayOptions.includePinned = !useBoolean(
      selectedTagPreferences?.hidePinned,
      this.preferences.getValue(PrefKey.NotesHidePinned, PrefDefaults[PrefKey.NotesHidePinned]),
    )

    newDisplayOptions.includeProtected = !useBoolean(
      selectedTagPreferences?.hideProtected,
      this.preferences.getValue(PrefKey.NotesHideProtected, PrefDefaults[PrefKey.NotesHideProtected]),
    )

    newWebDisplayOptions.hideNotePreview = useBoolean(
      selectedTagPreferences?.hideNotePreview,
      this.preferences.getValue(PrefKey.NotesHideNotePreview, PrefDefaults[PrefKey.NotesHideNotePreview]),
    )

    newWebDisplayOptions.hideDate = useBoolean(
      selectedTagPreferences?.hideDate,
      this.preferences.getValue(PrefKey.NotesHideDate, PrefDefaults[PrefKey.NotesHideDate]),
    )

    newWebDisplayOptions.hideTags = useBoolean(
      selectedTagPreferences?.hideTags,
      this.preferences.getValue(PrefKey.NotesHideTags, PrefDefaults[PrefKey.NotesHideTags]),
    )

    newWebDisplayOptions.hideEditorIcon = useBoolean(
      selectedTagPreferences?.hideEditorIcon,
      this.preferences.getValue(PrefKey.NotesHideEditorIcon, PrefDefaults[PrefKey.NotesHideEditorIcon]),
    )

    const customOrderChanged =
      (newDisplayOptions.customOrder ?? []).join(',') !== (this.displayOptions.customOrder ?? []).join(',')

    const displayOptionsChanged =
      newDisplayOptions.sortBy !== this.displayOptions.sortBy ||
      newDisplayOptions.sortDirection !== this.displayOptions.sortDirection ||
      customOrderChanged ||
      newDisplayOptions.includePinned !== this.displayOptions.includePinned ||
      newDisplayOptions.includeArchived !== this.displayOptions.includeArchived ||
      newDisplayOptions.includeTrashed !== this.displayOptions.includeTrashed ||
      newDisplayOptions.includeProtected !== this.displayOptions.includeProtected ||
      newWebDisplayOptions.hideNotePreview !== this.webDisplayOptions.hideNotePreview ||
      newWebDisplayOptions.hideDate !== this.webDisplayOptions.hideDate ||
      newWebDisplayOptions.hideEditorIcon !== this.webDisplayOptions.hideEditorIcon ||
      newWebDisplayOptions.hideTags !== this.webDisplayOptions.hideTags

    this.displayOptions = newDisplayOptions
    this.webDisplayOptions = newWebDisplayOptions

    if (!displayOptionsChanged) {
      return { didReloadItems: false }
    }

    this.reloadNotesDisplayOptions()

    await this.reloadItems(
      userTriggered ? ItemsReloadSource.UserTriggeredTagChange : ItemsReloadSource.DisplayOptionsChange,
    )

    const didSortByChange = currentSortBy !== this.displayOptions.sortBy
    const didSortDirectionChange = currentSortDirection !== this.displayOptions.sortDirection
    const didSortPrefChange = didSortByChange || didSortDirectionChange

    if (didSortPrefChange && this.shouldSelectFirstItem(ItemsReloadSource.DisplayOptionsChange)) {
      await this.selectFirstItem()
    }

    return { didReloadItems: true }
  }

  async createNewNoteController(
    title?: string,
    createdAt?: Date,
    autofocusBehavior: TemplateNoteViewAutofocusBehavior = 'editor',
    openInNewTile = false,
  ) {
    const selectedTag = this.navigationController.selected

    const activeRegularTagUuid = selectedTag instanceof SNTag ? selectedTag.uuid : undefined

    return this.itemControllerGroup.createItemController({
      templateOptions: {
        title,
        tag: activeRegularTagUuid,
        createdAt,
        autofocusBehavior,
        vault: this.vaultDisplayService.exclusivelyShownVault,
      },
      openInNewTile,
    })
  }

  /**
   * Standard Red Notes: gives feedback that an explicit, user-initiated note was
   * created — a short, deduped confirmation toast plus a brief row highlight keyed
   * off the new note's uuid. Reusing a fixed toast id means rapid creation replaces
   * the existing toast instead of stacking noisy ones. Never called for
   * placeholder/daily/auto creation.
   */
  flashNoteCreated = (uuid: UuidString) => {
    addToast({
      id: NoteCreatedToastId,
      type: ToastType.Success,
      message: 'New note created',
      autoClose: true,
      duration: 1500,
    })

    this.recentlyCreatedNoteUuid = uuid

    if (this.recentlyCreatedNoteTimeout) {
      clearTimeout(this.recentlyCreatedNoteTimeout)
    }
    this.recentlyCreatedNoteTimeout = setTimeout(() => {
      this.clearRecentlyCreatedNote()
    }, NoteCreatedHighlightDurationMs)
  }

  clearRecentlyCreatedNote = () => {
    this.recentlyCreatedNoteUuid = undefined
    this.recentlyCreatedNoteTimeout = undefined
  }

  /**
   * Creates a brand new note and opens it as an additional tab/tile without closing
   * any currently open ones. Used by the "+" button in the tabbed/tiled editor, which
   * must always produce a new tab (unlike `openNoteInNewTile`, which is a no-op when the
   * highlighted note is already open).
   */
  openNewNoteInNewTile = async (): Promise<void> => {
    const useTitle = this.titleForNewNote()

    const controller = await this.createNewNoteController(useTitle, undefined, 'editor', true)

    this.scrollToItem(controller.item)

    this.flashNoteCreated(controller.item.uuid)

    await this.publishCrossControllerEventSync(CrossControllerEvent.ActiveEditorChanged)
  }

  titleForNewNote = (createdAt?: Date) => {
    if (this.isFiltering) {
      return this.noteFilterText
    }

    const selectedTag = this.navigationController.selected
    const isSystemTag = selectedTag && isSmartView(selectedTag) && isSystemView(selectedTag)
    const selectedTagPreferences = isSystemTag
      ? this.preferences.getValue(PrefKey.SystemViewPreferences)?.[selectedTag.uuid as SystemViewId]
      : selectedTag?.preferences

    const titleFormat =
      selectedTagPreferences?.newNoteTitleFormat ||
      this.preferences.getValue(PrefKey.NewNoteTitleFormat, PrefDefaults[PrefKey.NewNoteTitleFormat])

    if (titleFormat === NewNoteTitleFormat.CurrentNoteCount) {
      return `Note ${this.notes.length + 1}`
    }

    if (titleFormat === NewNoteTitleFormat.CustomFormat) {
      const customFormat =
        this.navigationController.selected?.preferences?.customNoteTitleFormat ||
        this.preferences.getValue(PrefKey.CustomNoteTitleFormat, PrefDefaults[PrefKey.CustomNoteTitleFormat])

      try {
        return getDayjsFormattedString(createdAt, customFormat)
      } catch (error) {
        console.error(error)
        return formatDateAndTimeForNote(createdAt || new Date())
      }
    }

    if (titleFormat === NewNoteTitleFormat.Empty) {
      return ''
    }

    return formatDateAndTimeForNote(createdAt || new Date())
  }

  createNewNote = async (
    title?: string,
    createdAt?: Date,
    autofocusBehavior?: TemplateNoteViewAutofocusBehavior,
    /**
     * Standard Red Notes: whether this is an explicit user action (create button,
     * command, quick action). Only then do we show the confirmation toast + row
     * highlight. Placeholder/daily/auto creation pass false to avoid spam.
     */
    userTriggered = false,
  ) => {
    void this.publishCrossControllerEventSync(CrossControllerEvent.UnselectAllNotes)

    if (
      this.navigationController.isInSmartView() &&
      !this.navigationController.isInHomeView() &&
      !this.navigationController.isInSystemView(SystemViewId.UntaggedNotes)
    ) {
      await this.navigationController.selectHomeNavigationView()
    }

    const useTitle = title || this.titleForNewNote(createdAt)

    const controller = await this.createNewNoteController(useTitle, createdAt, autofocusBehavior)

    this.scrollToItem(controller.item)

    if (userTriggered) {
      this.flashNoteCreated(controller.item.uuid)
    }
  }

  createPlaceholderNote = () => {
    if (this.navigationController.isInSmartView() && !this.navigationController.isInHomeView()) {
      return
    }

    return this.createNewNote()
  }

  get optionsSubtitle(): string | undefined {
    if (!this.displayOptions.includePinned && !this.displayOptions.includeProtected) {
      return 'Excluding pinned and protected'
    }
    if (!this.displayOptions.includePinned) {
      return 'Excluding pinned'
    }
    if (!this.displayOptions.includeProtected) {
      return 'Excluding protected'
    }

    return undefined
  }

  paginate = () => {
    this.notesToDisplay += this.pageSize

    void this.reloadItems(ItemsReloadSource.Pagination)

    if (this.searchSubmitted) {
      this.desktopManager?.searchText(this.noteFilterText)
    }
  }

  resetPagination = (keepCurrentIfLarger = false) => {
    const clientHeight = document.documentElement.clientHeight
    this.pageSize = Math.ceil(clientHeight / MinNoteCellHeight)
    if (this.pageSize === 0) {
      this.pageSize = DefaultListNumNotes
    }
    if (keepCurrentIfLarger && this.notesToDisplay > this.pageSize) {
      return
    }
    this.notesToDisplay = this.pageSize
  }

  getFirstNonProtectedItem = () => {
    return this.items.find((item) => !item.protected)
  }

  get notesListScrollContainer() {
    return document.getElementById(ElementIdScrollContainer)
  }

  selectFirstItem = async () => {
    const item = this.getFirstNonProtectedItem()

    if (this.isTableViewEnabled && !isMobileScreen()) {
      return
    }

    if (item) {
      log(LoggingDomain.Selection, 'Selecting first item', item.uuid)

      await this.selectItemWithScrollHandling(item, {
        userTriggered: false,
        scrollIntoView: false,
      })

      this.resetScrollPosition()
    }
  }

  selectNextItemOrCreateNewNote = async () => {
    const item = this.getFirstNonProtectedItem()

    if (item) {
      log(LoggingDomain.Selection, 'selectNextItemOrCreateNewNote')
      await this.selectItemWithScrollHandling(item, {
        userTriggered: false,
        scrollIntoView: false,
      }).catch(console.error)
    } else {
      await this.createNewNote()
    }
  }

  setNoteFilterText = (text: string) => {
    if (text === this.noteFilterText) {
      return
    }

    const wasFiltering = this.noteFilterText.trim().length > 0
    const isNowFiltering = text.trim().length > 0

    this.noteFilterText = text

    // Standard Red Notes: any AI contextual re-rank was computed for the previous
    // query text; once the query changes it no longer applies. Drop it so the list
    // falls back to the algorithmic order until the user runs "Search with AI"
    // again. (applyContextualAiOrdering also guards on query match, but clearing
    // here keeps the action's "active" UI state honest.)
    this.clearAiContextualOrder()

    // Standard Red Notes: auto-engage Relevance when a search begins, and revert
    // to the prior field sort when the query is cleared.
    if (isNowFiltering && !wasFiltering) {
      this.engageRelevanceSortForSearch()
    } else if (!isNowFiltering && wasFiltering) {
      this.disengageRelevanceSort()
    }

    this.handleFilterTextChanged()
  }

  /**
   * Standard Red Notes: whether a Relevance sort is meaningful right now (i.e. a
   * search query is active). The sort menu uses this to surface/enable the
   * Relevance option only while searching.
   */
  get isRelevanceSortAvailable(): boolean {
    return this.noteFilterText.trim().length > 0
  }

  setRelevanceSortActive = (active: boolean): void => {
    this.relevanceSortActive = active
  }

  /**
   * User explicitly selects the Relevance sort from the display-options menu.
   * Only has an effect while searching. The underlying model field sort
   * (displayOptions.sortBy) is left untouched, so clearing the query (which
   * turns this flag off) automatically reverts to whatever field sort was active.
   */
  selectRelevanceSort = (): void => {
    if (!this.isRelevanceSortAvailable || this.relevanceSortActive) {
      return
    }
    this.setRelevanceSortActive(true)
    void this.reloadItems(ItemsReloadSource.DisplayOptionsChange)
  }

  /**
   * Leaving Relevance for a field sort while still searching: drop the relevance
   * flag so the model field sort (date/title/custom) takes over again.
   */
  exitRelevanceSort = (): void => {
    if (!this.relevanceSortActive) {
      return
    }
    this.setRelevanceSortActive(false)
    void this.reloadItems(ItemsReloadSource.DisplayOptionsChange)
  }

  /** Auto-engage Relevance as a search starts. */
  private engageRelevanceSortForSearch(): void {
    if (!this.relevanceSortActive) {
      this.setRelevanceSortActive(true)
    }
  }

  /**
   * Revert when the search query is cleared. Because the model field sort was
   * never changed, simply dropping the relevance flag restores the prior order.
   */
  private disengageRelevanceSort(): void {
    if (this.relevanceSortActive) {
      this.setRelevanceSortActive(false)
    }
  }

  handleEditorChange = async () => {
    const activeNote = this.itemControllerGroup.activeItemViewController?.item

    if (activeNote && activeNote.conflictOf) {
      void this._changeAndSaveItem.execute(activeNote, (mutator) => {
        mutator.conflictOf = undefined
      })
    }

    if (this.isFiltering) {
      this.desktopManager?.searchText(this.noteFilterText)
    }
  }

  resetScrollPosition = () => {
    if (this.notesListScrollContainer) {
      this.notesListScrollContainer.scrollTop = 0
      this.notesListScrollContainer.scrollLeft = 0
    }
  }

  private closeItemController(controller: NoteViewController | FileViewController): void {
    log(LoggingDomain.Selection, 'Closing item controller', controller.runtimeId)
    this.itemControllerGroup.closeItemController(controller)
  }

  handleTagChange = async (userTriggered: boolean) => {
    this.clearKeepActiveItemOpenUuid()
    const activeNoteController = this.getActiveItemController()
    if (activeNoteController instanceof NoteViewController && activeNoteController.isTemplateNote) {
      this.closeItemController(activeNoteController)
    }

    this.resetScrollPosition()

    this.setShowDisplayOptionsMenu(false)

    this.setNoteFilterText('')

    this.desktopManager?.searchText()

    this.resetPagination()

    const { didReloadItems } = await this.reloadDisplayPreferences({ userTriggered })

    if (!didReloadItems) {
      this.reloadNotesDisplayOptions()
      void this.reloadItems(userTriggered ? ItemsReloadSource.UserTriggeredTagChange : ItemsReloadSource.TagChange)
    }
  }

  onFilterEnter = () => {
    /**
     * For Desktop, performing a search right away causes
     * input to lose focus. We wait until user explicity hits
     * enter before highlighting desktop search results.
     */
    this.searchSubmitted = true

    this.desktopManager?.searchText(this.noteFilterText)
  }

  get isCurrentNoteTemplate(): boolean {
    const controller = this.getActiveItemController()

    if (!controller) {
      return false
    }

    return controller instanceof NoteViewController && controller.isTemplateNote
  }

  public async insertCurrentIfTemplate(): Promise<void> {
    const controller = this.getActiveItemController()

    if (!controller) {
      return
    }

    if (controller instanceof NoteViewController && controller.isTemplateNote) {
      await controller.insertTemplatedNote()
    }
  }

  handleFilterTextChanged = () => {
    if (this.searchSubmitted) {
      this.searchSubmitted = false
    }

    this.reloadNotesDisplayOptions()

    void this.reloadItems(ItemsReloadSource.FilterTextChange)
  }

  clearFilterText = () => {
    this.setNoteFilterText('')
    this.onFilterEnter()
    this.handleFilterTextChanged()
    this.resetPagination()
  }

  get selectedItemsCount(): number {
    return Object.keys(this.selectedItems).length
  }

  get selectedFiles(): FileItem[] {
    return this.getFilteredSelectedItems<FileItem>(ContentType.TYPES.File)
  }

  get selectedFilesCount(): number {
    return this.selectedFiles.length
  }

  get firstSelectedItem() {
    return Object.values(this.selectedItems)[0]
  }

  getSelectedItems = () => {
    const uuids = Array.from(this.selectedUuids)
    return uuids.map((uuid) => this.itemManager.findSureItem<SNNote | FileItem>(uuid)).filter((item) => !!item)
  }

  getFilteredSelectedItems = <T extends ListableContentItem = ListableContentItem>(contentType?: string): T[] => {
    return Object.values(this.selectedItems).filter((item) => {
      return !contentType ? true : item.content_type === contentType
    }) as T[]
  }

  setSelectedItems = () => {
    this.selectedItems = Object.fromEntries(this.getSelectedItems().map((item) => [item.uuid, item]))
  }

  setSelectedUuids = (selectedUuids: Set<UuidString>) => {
    log(LoggingDomain.Selection, 'Setting selected uuids', selectedUuids)
    this.selectedUuids = new Set(selectedUuids)
    this.setSelectedItems()
  }

  private removeSelectedItem = (uuid: UuidString) => {
    this.selectedUuids.delete(uuid)
    this.setSelectedUuids(this.selectedUuids)
    delete this.selectedItems[uuid]
  }

  public deselectItem = (item: { uuid: ListableContentItem['uuid'] }): void => {
    log(LoggingDomain.Selection, 'Deselecting item', item.uuid)
    this.removeSelectedItem(item.uuid)

    if (item.uuid === this.lastSelectedItem?.uuid) {
      this.lastSelectedItem = undefined
    }
  }

  public isItemSelected = (item: ListableContentItem): boolean => {
    return this.selectedUuids.has(item.uuid)
  }

  private selectItemsRange = async ({
    selectedItem,
    startingIndex,
    endingIndex,
  }: {
    selectedItem?: ListableContentItem
    startingIndex?: number
    endingIndex?: number
  }): Promise<void> => {
    const items = this.renderedItems

    const lastSelectedItemIndex = startingIndex ?? items.findIndex((item) => item.uuid == this.lastSelectedItem?.uuid)
    const selectedItemIndex = endingIndex ?? items.findIndex((item) => item.uuid == selectedItem?.uuid)

    let itemsToSelect = []
    if (selectedItemIndex > lastSelectedItemIndex) {
      itemsToSelect = items.slice(lastSelectedItemIndex, selectedItemIndex + 1)
    } else {
      itemsToSelect = items.slice(selectedItemIndex, lastSelectedItemIndex + 1)
    }

    const authorizedItems = await this.protections.authorizeProtectedActionForItems(
      itemsToSelect,
      ChallengeReason.SelectProtectedNote,
    )

    for (const item of authorizedItems) {
      runInAction(() => {
        this.setSelectedUuids(this.selectedUuids.add(item.uuid))
        this.lastSelectedItem = item
        if (this.selectedItemsCount > 1 && !this.isMultipleSelectionMode) {
          this.enableMultipleSelectionMode()
        }
      })
    }
  }

  cancelMultipleSelection = () => {
    this.keyboardService.cancelAllKeyboardModifiers()

    this.isMultipleSelectionMode = false

    const firstSelectedItem = this.firstSelectedItem

    if (firstSelectedItem) {
      this.replaceSelection(firstSelectedItem)
    } else {
      this.deselectAll()
    }
  }

  replaceSelection = (item: ListableContentItem): void => {
    runInAction(() => this.setSelectedUuids(new Set([item.uuid])))
    this.lastSelectedItem = item
  }

  selectAll = () => {
    const allItems = this.items.filter((item) => !item.protected)
    const lastItem = allItems[allItems.length - 1]
    this.setSelectedUuids(new Set(Uuids(allItems)))
    this.lastSelectedItem = lastItem
    this.enableMultipleSelectionMode()
  }

  deselectAll = (): void => {
    this.selectedUuids.clear()
    this.setSelectedUuids(this.selectedUuids)

    this.lastSelectedItem = undefined
  }

  openSingleSelectedItem = async ({ userTriggered } = { userTriggered: true }) => {
    if (this.selectedItemsCount === 1) {
      const item = this.firstSelectedItem

      if (item.content_type === ContentType.TYPES.Note) {
        await this.openNote(item.uuid)
      } else if (item.content_type === ContentType.TYPES.File) {
        await this.openFile(item.uuid)
      }
      this.recents.add(item.uuid)

      if (!this.paneController.isInMobileView || userTriggered) {
        void this.paneController.setPaneLayout(PaneLayout.Editing)
      }

      if (this.paneController.isInMobileView && userTriggered) {
        requestCloseAllOpenModalsAndPopovers()
      }
    }
  }

  enableMultipleSelectionMode = () => {
    this.isMultipleSelectionMode = true
  }

  selectItemUsingInstance = async (
    item: ListableContentItem,
    userTriggered?: boolean,
  ): Promise<{ didSelect: boolean }> => {
    const uuid = item.uuid

    log(LoggingDomain.Selection, 'Select item', uuid)

    const hasShift = this.keyboardService.activeModifiers.has(KeyboardModifier.Shift)
    const hasMoreThanOneSelected = this.selectedItemsCount > 1
    const isAuthorizedForAccess = await this.protections.authorizeItemAccess(item)

    if (userTriggered && hasShift && !isMobileScreen()) {
      await this.selectItemsRange({ selectedItem: item })
    } else if (userTriggered && this.isMultipleSelectionMode) {
      if (this.selectedUuids.has(uuid)) {
        this.removeSelectedItem(uuid)
      } else if (isAuthorizedForAccess) {
        this.selectedUuids.add(uuid)
        this.setSelectedUuids(this.selectedUuids)
        this.lastSelectedItem = item
      }
    } else {
      const shouldSelectNote = hasMoreThanOneSelected || !this.selectedUuids.has(uuid)
      if (shouldSelectNote && isAuthorizedForAccess) {
        this.replaceSelection(item)
        await this.openSingleSelectedItem({ userTriggered: userTriggered ?? false })
      }
    }

    if (this.keepActiveItemOpenUuid && uuid !== this.keepActiveItemOpenUuid) {
      this.clearKeepActiveItemOpenUuid()
    }

    return {
      didSelect: this.selectedUuids.has(uuid),
    }
  }

  keepActiveItemOpenForSystemView = (noteUuid: UuidString): void => {
    this.keepActiveItemOpenUuid = noteUuid
  }

  private clearKeepActiveItemOpenUuid(): void {
    this.keepActiveItemOpenUuid = undefined
  }

  selectItem = async (
    uuid: UuidString,
    userTriggered?: boolean,
  ): Promise<{
    didSelect: boolean
  }> => {
    const item = this.itemManager.findItem<ListableContentItem>(uuid)

    if (!item) {
      return {
        didSelect: false,
      }
    }

    return this.selectItemUsingInstance(item, userTriggered)
  }

  selectItemWithScrollHandling = async (
    item: {
      uuid: ListableContentItem['uuid']
    },
    { userTriggered = false, scrollIntoView = true, animated = true },
  ): Promise<void> => {
    const { didSelect } = await this.selectItem(item.uuid, userTriggered)

    const avoidMobileScrollingDueToIncompatibilityWithPaneAnimations = isMobileScreen()

    if (didSelect && scrollIntoView && !avoidMobileScrollingDueToIncompatibilityWithPaneAnimations) {
      this.scrollToItem(item, animated)
    }
  }

  scrollToItem = (item: { uuid: ListableContentItem['uuid'] }, animated = true): void => {
    const itemElement = document.getElementById(item.uuid)
    itemElement?.scrollIntoView({
      behavior: animated ? 'smooth' : 'auto',
    })
  }

  selectUuids = async (uuids: UuidString[], userTriggered = false) => {
    const itemsForUuids = this.itemManager.findItems(uuids).filter((item) => !isFile(item))

    if (itemsForUuids.length < 1) {
      return
    }

    if (!userTriggered && itemsForUuids.some((item) => item.protected && isFile(item))) {
      return
    }

    this.setSelectedUuids(new Set(Uuids(itemsForUuids)))

    if (itemsForUuids.length === 1) {
      void this.openSingleSelectedItem({ userTriggered })
    }
  }

  selectNextItem = ({ userTriggered } = { userTriggered: true }) => {
    const displayableItems = this.items

    const currentIndex = displayableItems.findIndex((candidate) => {
      return candidate.uuid === this.lastSelectedItem?.uuid
    })

    let nextIndex = currentIndex + 1

    while (nextIndex < displayableItems.length) {
      const nextItem = displayableItems[nextIndex]

      nextIndex++

      if (nextItem.protected) {
        continue
      }

      this.selectItemWithScrollHandling(nextItem, { userTriggered }).catch(console.error)

      const nextNoteElement = document.getElementById(nextItem.uuid)

      nextNoteElement?.focus()

      return
    }
  }

  /** Standard Red Notes: whether the notes list is currently in Custom (manual) sort mode. */
  get isCustomSortMode(): boolean {
    return this.displayOptions.sortBy === CollectionSort.Custom
  }

  /**
   * Standard Red Notes: persist a new manual order for the notes list after a
   * drag-and-drop reorder. `orderedUuids` is the full visible ordering the user
   * produced; we seed the stored CustomNotesOrder with it (merging any other
   * known uuids not currently visible so they aren't lost), then save. The pref
   * change re-runs reloadDisplayPreferences which reloads the list.
   */
  setCustomNotesOrder = async (orderedUuids: UuidString[]): Promise<void> => {
    const previous = this.preferences.getValue(PrefKey.CustomNotesOrder, PrefDefaults[PrefKey.CustomNotesOrder])
    const visibleSet = new Set(orderedUuids)
    // Preserve previously-ordered uuids that aren't part of this visible reorder
    // (e.g. notes hidden by the current tag/search filter) by appending them.
    const preserved = previous.filter((uuid) => !visibleSet.has(uuid))
    const next = [...orderedUuids, ...preserved]
    await this.preferences.setValue(PrefKey.CustomNotesOrder, next)
  }

  /**
   * Standard Red Notes: move the dragged item so it sits immediately before the
   * target item in the current rendered order, then persist. Used by the notes
   * list drag-and-drop handlers.
   */
  reorderNoteByDrag = async (draggedUuid: UuidString, targetUuid: UuidString): Promise<void> => {
    if (draggedUuid === targetUuid) {
      return
    }
    const current = this.items.map((item) => item.uuid)
    const withoutDragged = current.filter((uuid) => uuid !== draggedUuid)
    const targetIndex = withoutDragged.indexOf(targetUuid)
    if (targetIndex === -1) {
      return
    }
    withoutDragged.splice(targetIndex, 0, draggedUuid)
    await this.setCustomNotesOrder(withoutDragged)
  }

  selectPreviousItem = () => {
    const displayableItems = this.items

    if (!this.lastSelectedItem) {
      return
    }

    const currentIndex = displayableItems.indexOf(this.lastSelectedItem)

    let previousIndex = currentIndex - 1

    while (previousIndex >= 0) {
      const previousItem = displayableItems[previousIndex]

      previousIndex--

      if (previousItem.protected) {
        continue
      }

      this.selectItemWithScrollHandling(previousItem, { userTriggered: true }).catch(console.error)

      const previousNoteElement = document.getElementById(previousItem.uuid)

      previousNoteElement?.focus()

      return
    }
  }
}

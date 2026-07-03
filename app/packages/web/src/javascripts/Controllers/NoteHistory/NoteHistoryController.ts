import { RevisionType } from '@/Components/RevisionHistoryModal/RevisionType'
import { sortRevisionListIntoGroups } from '@/Components/RevisionHistoryModal/utils'
import { STRING_RESTORE_LOCKED_ATTEMPT } from '@/Constants/Strings'
import { confirmDialog } from '@standardnotes/ui-services'
import {
  Action,
  ActionVerb,
  ActionsService,
  AlertService,
  ButtonType,
  ChangeAndSaveItem,
  DeleteRevision,
  FeaturesClientInterface,
  GetRevision,
  HistoryEntry,
  HistoryServiceInterface,
  ItemManagerInterface,
  ListRevisions,
  MutatorClientInterface,
  NoteContent,
  NoteHistoryEntry,
  PayloadEmitSource,
  RevisionMetadata,
  SNNote,
  SyncServiceInterface,
} from '@standardnotes/snjs'
import { makeObservable, observable, action } from 'mobx'
import {
  RemoteHistory,
  SessionHistory,
  LegacyHistory,
  SelectedRevision,
  SelectedEntry,
  RevisionContentState,
} from './Types'
import { ItemListController } from '../ItemList/ItemListController'

export class NoteHistoryController {
  remoteHistory: RemoteHistory = []
  isFetchingRemoteHistory = false
  sessionHistory: SessionHistory = []
  legacyHistory: LegacyHistory = []

  selectedRevision: SelectedRevision = undefined
  selectedEntry: SelectedEntry = undefined

  /** When true, the content pane renders a diff instead of a single revision. */
  isComparing = false
  /** What the selected revision is diffed against in compare mode. */
  compareTarget: 'current' | 'previous' = 'current'

  contentState = RevisionContentState.Idle

  currentTab = RevisionType.Remote

  constructor(
    private note: SNNote,
    private itemListController: ItemListController,
    private features: FeaturesClientInterface,
    private items: ItemManagerInterface,
    private mutator: MutatorClientInterface,
    private sync: SyncServiceInterface,
    private actions: ActionsService,
    private history: HistoryServiceInterface,
    private alerts: AlertService,
    private _getRevision: GetRevision,
    private _listRevisions: ListRevisions,
    private _deleteRevision: DeleteRevision,
    private _changeAndSaveItem: ChangeAndSaveItem,
  ) {
    makeObservable(this, {
      selectedRevision: observable,
      setSelectedRevision: action,

      selectedEntry: observable,
      setSelectedEntry: action,

      isComparing: observable,
      setIsComparing: action,
      compareTarget: observable,
      setCompareTarget: action,
      comparisonContent: observable,
      setComparisonContent: action,

      remoteHistory: observable,
      setRemoteHistory: action,
      isFetchingRemoteHistory: observable,
      setIsFetchingRemoteHistory: action,

      sessionHistory: observable,
      setSessionHistory: action,

      legacyHistory: observable,
      setLegacyHistory: action,

      resetHistoryState: action,

      currentTab: observable,
      selectTab: action,

      contentState: observable,
      setContentState: action,
    })

    void this.fetchAllHistory()
  }

  setSelectedRevision = (revision: SelectedRevision) => {
    this.selectedRevision = revision
    if (this.isComparing) {
      void this.refreshComparisonContent()
    }
  }

  setSelectedEntry = (entry: SelectedEntry) => {
    this.selectedEntry = entry
  }

  /**
   * Holds the resolved content the selected revision is diffed against while in
   * compare mode. `undefined` while loading or unavailable.
   */
  comparisonContent: NoteContent | undefined = undefined

  setComparisonContent = (content: NoteContent | undefined) => {
    this.comparisonContent = content
  }

  setIsComparing = (value: boolean) => {
    this.isComparing = value
    if (value) {
      void this.refreshComparisonContent()
    } else {
      this.setComparisonContent(undefined)
    }
  }

  setCompareTarget = (target: 'current' | 'previous') => {
    this.compareTarget = target
    if (this.isComparing) {
      void this.refreshComparisonContent()
    }
  }

  /** The note's current (live) content, used for "compare with current". */
  get currentNoteContent(): NoteContent | undefined {
    const liveNote = this.items.findItem<SNNote>(this.note.uuid) ?? this.note
    return liveNote?.content as NoteContent | undefined
  }

  /**
   * Resolves the content to diff against, based on the active compare target,
   * and stores it on `comparisonContent`. For "previous" we resolve the
   * next-older revision relative to the current selection WITHIN THE ACTIVE TAB's
   * own entry list — session and legacy entries have no top-level `uuid`, so the
   * previous entry must be derived by POSITION in that tab's list, not by looking
   * the selection up in the remote list by uuid (which always missed for
   * session/legacy → "No previous revision available").
   */
  refreshComparisonContent = async () => {
    if (this.compareTarget === 'current') {
      this.setComparisonContent(this.currentNoteContent)
      return
    }

    this.setComparisonContent(undefined)

    if (!this.note || !this.selectedEntry) {
      return
    }

    switch (this.currentTab) {
      case RevisionType.Remote:
        await this.refreshRemotePreviousComparison()
        break
      case RevisionType.Session:
        this.refreshSessionPreviousComparison()
        break
      case RevisionType.Legacy:
        await this.refreshLegacyPreviousComparison()
        break
    }
  }

  /**
   * Remote tab: the entries are RevisionMetadata (uuid-identified) and their
   * content lives on the server, so the previous entry (next-older = index + 1 in
   * the newest-first list) is fetched on demand.
   */
  private refreshRemotePreviousComparison = async () => {
    const selectedUuid = (this.selectedEntry as RevisionMetadata | undefined)?.uuid
    if (!selectedUuid) {
      return
    }

    const currentIndex = this.flattenedRemoteHistory.findIndex((entry) => entry?.uuid === selectedUuid)
    if (currentIndex === -1) {
      return
    }

    const previousEntry = this.flattenedRemoteHistory[currentIndex + 1]
    if (!previousEntry) {
      return
    }

    if (!this.features.hasMinimumRole(previousEntry.required_role)) {
      return
    }

    try {
      const previousRevisionOrError = await this._getRevision.execute({
        itemUuid: this.note.uuid,
        revisionUuid: previousEntry.uuid,
      })
      if (previousRevisionOrError.isFailed()) {
        throw new Error(previousRevisionOrError.getError())
      }
      this.setComparisonContent(previousRevisionOrError.getValue().payload.content as NoteContent)
    } catch (err) {
      console.error(err)
      this.setComparisonContent(undefined)
    }
  }

  /**
   * Session tab: entries are NoteHistoryEntry and already carry their content
   * in-memory (`payload.content`), so the previous entry (index + 1 in the
   * newest-first list) is resolved synchronously with no fetch.
   */
  private refreshSessionPreviousComparison = () => {
    const entries = this.flattenedSessionHistory
    const currentIndex = entries.findIndex((entry) => entry === this.selectedEntry)
    if (currentIndex === -1) {
      return
    }

    const previousEntry = entries[currentIndex + 1]
    if (!previousEntry) {
      return
    }

    this.setComparisonContent(previousEntry.payload.content as NoteContent)
  }

  /**
   * Legacy tab: entries are Actions identified by their subaction URL, and their
   * content must be fetched by running the action (as when a legacy revision is
   * selected). The previous entry is index + 1 in the list.
   */
  private refreshLegacyPreviousComparison = async () => {
    const selectedUrl = (this.selectedEntry as Action | undefined)?.subactions?.[0]?.url
    if (!selectedUrl) {
      return
    }

    const currentIndex = this.legacyHistory.findIndex((entry) => entry.subactions?.[0]?.url === selectedUrl)
    if (currentIndex === -1) {
      return
    }

    const previousEntry = this.legacyHistory[currentIndex + 1]
    if (!previousEntry?.subactions?.[0]) {
      return
    }

    try {
      const response = await this.actions.runAction(previousEntry.subactions[0], this.note)
      if (!response) {
        return
      }
      const content = (response.item as unknown as HistoryEntry | undefined)?.payload?.content
      this.setComparisonContent((content as NoteContent | undefined) ?? undefined)
    } catch (err) {
      console.error(err)
      this.setComparisonContent(undefined)
    }
  }

  clearSelection = () => {
    this.setSelectedEntry(undefined)
    this.setSelectedRevision(undefined)
  }

  selectTab = (tab: RevisionType) => {
    this.currentTab = tab
    this.clearSelection()
    this.setContentState(RevisionContentState.Idle)
    this.selectFirstRevision()
  }

  setIsFetchingRemoteHistory = (value: boolean) => {
    this.isFetchingRemoteHistory = value
  }

  setContentState = (contentState: RevisionContentState) => {
    this.contentState = contentState
  }

  selectRemoteRevision = async (entry: RevisionMetadata) => {
    if (!this.note) {
      return
    }

    if (!this.features.hasMinimumRole(entry.required_role)) {
      this.setContentState(RevisionContentState.NotEntitled)
      this.setSelectedRevision(undefined)
      return
    }

    this.setContentState(RevisionContentState.Loading)
    this.clearSelection()

    try {
      this.setSelectedEntry(entry)
      const remoteRevisionOrError = await this._getRevision.execute({
        itemUuid: this.note.uuid,
        revisionUuid: entry.uuid,
      })
      if (remoteRevisionOrError.isFailed()) {
        throw new Error(remoteRevisionOrError.getError())
      }
      const remoteRevision = remoteRevisionOrError.getValue()
      this.setSelectedRevision(remoteRevision)
    } catch (err) {
      this.clearSelection()
      console.error(err)
    } finally {
      this.setContentState(RevisionContentState.Loaded)
    }
  }

  selectLegacyRevision = async (entry: Action) => {
    this.clearSelection()
    this.setContentState(RevisionContentState.Loading)

    if (!this.note) {
      return
    }

    try {
      if (!entry.subactions?.[0]) {
        throw new Error('Could not find revision action url')
      }

      this.setSelectedEntry(entry)

      const response = await this.actions.runAction(entry.subactions[0], this.note)

      if (!response) {
        throw new Error('Could not fetch revision')
      }

      this.setSelectedRevision(response.item as unknown as HistoryEntry)
    } catch (error) {
      console.error(error)
      this.setSelectedRevision(undefined)
    } finally {
      this.setContentState(RevisionContentState.Loaded)
    }
  }

  selectSessionRevision = (entry: NoteHistoryEntry) => {
    this.clearSelection()
    this.setSelectedEntry(entry)
    this.setSelectedRevision(entry)
    this.setContentState(RevisionContentState.Loaded)
  }

  private get flattenedRemoteHistory() {
    return this.remoteHistory.map((group) => group.entries).flat()
  }

  private get flattenedSessionHistory() {
    return this.sessionHistory.map((group) => group.entries).flat()
  }

  selectFirstRevision = () => {
    switch (this.currentTab) {
      case RevisionType.Remote: {
        const firstEntry = this.flattenedRemoteHistory[0]
        if (firstEntry) {
          void this.selectRemoteRevision(firstEntry)
        }
        break
      }
      case RevisionType.Session: {
        const firstEntry = this.flattenedSessionHistory[0]
        if (firstEntry) {
          void this.selectSessionRevision(firstEntry)
        }
        break
      }
      case RevisionType.Legacy: {
        const firstEntry = this.legacyHistory[0]
        if (firstEntry) {
          void this.selectLegacyRevision(firstEntry)
        }
        break
      }
    }
  }

  selectPrevOrNextRemoteRevision = (revisionEntry: RevisionMetadata) => {
    const currentIndex = this.flattenedRemoteHistory.findIndex((entry) => entry?.uuid === revisionEntry.uuid)

    const previousEntry = this.flattenedRemoteHistory[currentIndex - 1]
    const nextEntry = this.flattenedRemoteHistory[currentIndex + 1]

    if (previousEntry) {
      void this.selectRemoteRevision(previousEntry)
    } else if (nextEntry) {
      void this.selectRemoteRevision(nextEntry)
    }
  }

  setRemoteHistory = (remoteHistory: RemoteHistory) => {
    this.remoteHistory = remoteHistory
  }

  fetchRemoteHistory = async () => {
    this.setRemoteHistory([])

    if (this.note) {
      this.setIsFetchingRemoteHistory(true)
      try {
        const revisionsListOrError = await this._listRevisions.execute({ itemUuid: this.note.uuid })
        if (revisionsListOrError.isFailed()) {
          throw new Error(revisionsListOrError.getError())
        }
        const revisionsList = revisionsListOrError.getValue()

        this.setRemoteHistory(sortRevisionListIntoGroups<RevisionMetadata>(revisionsList))
      } catch (err) {
        console.error(err)
      } finally {
        this.setIsFetchingRemoteHistory(false)
      }
    }
  }

  setLegacyHistory = (legacyHistory: LegacyHistory) => {
    this.legacyHistory = legacyHistory
  }

  fetchLegacyHistory = async () => {
    const actionExtensions = this.actions.getExtensions()

    actionExtensions.forEach(async (ext) => {
      if (!this.note) {
        return
      }

      const actionExtension = await this.actions.loadExtensionInContextOfItem(ext, this.note)

      if (!actionExtension) {
        return
      }

      const isLegacyNoteHistoryExt = actionExtension?.actions.some((action) => action.verb === ActionVerb.Nested)

      if (!isLegacyNoteHistoryExt) {
        return
      }

      this.setLegacyHistory(actionExtension.actions.filter((action) => action.subactions?.[0]))
    })
  }

  setSessionHistory = (sessionHistory: SessionHistory) => {
    this.sessionHistory = sessionHistory
  }

  fetchAllHistory = async () => {
    this.resetHistoryState()

    if (!this.note) {
      return
    }

    this.setSessionHistory(
      sortRevisionListIntoGroups<NoteHistoryEntry>(this.history.sessionHistoryForItem(this.note) as NoteHistoryEntry[]),
    )
    await this.fetchRemoteHistory()
    await this.fetchLegacyHistory()

    this.selectFirstRevision()
  }

  resetHistoryState = () => {
    this.remoteHistory = []
    this.sessionHistory = []
    this.legacyHistory = []
  }

  restoreRevision = async (revision: NonNullable<SelectedRevision>) => {
    const originalNote = this.items.findItem<SNNote>(revision.payload.uuid)

    if (originalNote?.locked) {
      this.alerts.alert(STRING_RESTORE_LOCKED_ATTEMPT).catch(console.error)
      return
    }

    const didConfirm = await confirmDialog({
      text: "Are you sure you want to replace the current note's contents with what you see in this preview?",
      confirmButtonStyle: 'danger',
    })

    if (!originalNote) {
      throw new Error('Original note not found.')
    }

    if (didConfirm) {
      void this._changeAndSaveItem.execute(
        originalNote,
        (mutator) => {
          mutator.setCustomContent(revision.payload.content)
        },
        true,
        PayloadEmitSource.RemoteRetrieved,
      )
    }
  }

  restoreRevisionAsCopy = async (revision: NonNullable<SelectedRevision>) => {
    const originalNote = this.items.findSureItem<SNNote>(revision.payload.uuid)

    const duplicatedItem = await this.mutator.duplicateItem(originalNote, false, {
      ...revision.payload.content,
      title: revision.payload.content.title ? revision.payload.content.title + ' (copy)' : undefined,
    })

    void this.sync.sync()

    this.itemListController.selectItem(duplicatedItem.uuid).catch(console.error)
  }

  deleteRemoteRevision = async (revisionEntry: RevisionMetadata) => {
    const shouldDelete = await this.alerts.confirm(
      'Are you sure you want to delete this revision?',
      'Delete revision?',
      'Delete revision',
      ButtonType.Danger,
      'Cancel',
    )

    if (!shouldDelete || !this.note) {
      return
    }

    const deleteRevisionOrError = await this._deleteRevision.execute({
      itemUuid: this.note.uuid,
      revisionUuid: revisionEntry.uuid,
    })
    if (deleteRevisionOrError.isFailed()) {
      throw new Error(deleteRevisionOrError.getError())
    }

    this.clearSelection()

    this.selectPrevOrNextRemoteRevision(revisionEntry)

    await this.fetchRemoteHistory()
  }
}

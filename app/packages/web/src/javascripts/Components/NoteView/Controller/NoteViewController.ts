import { noteTypeForEditorIdentifier, NoteType } from '@standardnotes/features'
import { achievements, METRICS } from '@/Achievements'
import {
  SNNote,
  SNTag,
  NoteContent,
  DecryptedItemInterface,
  PayloadEmitSource,
  PrefKey,
  PayloadVaultOverrides,
  isLitePayload,
} from '@standardnotes/models'
import {
  AlertService,
  ComponentManagerInterface,
  ItemManagerInterface,
  MutatorClientInterface,
  PreferenceServiceInterface,
  SessionsClientInterface,
  SyncServiceInterface,
  UuidString,
} from '@standardnotes/snjs'
import { removeFromArray } from '@standardnotes/utils'
import { ContentType } from '@standardnotes/domain-core'
import { ItemViewControllerInterface } from './ItemViewControllerInterface'
import { TemplateNoteViewControllerOptions } from './TemplateNoteViewControllerOptions'
import { log, LoggingDomain } from '@/Logging'
import { NoteSaveFunctionParams, NoteSyncController } from '../../../Controllers/NoteSyncController'
import { IsNativeMobileWeb } from '@standardnotes/ui-services'
import { NoteStatus } from '../NoteStatusIndicator'

export type EditorValues = {
  title: string
  text: string
}

export class NoteViewController implements ItemViewControllerInterface {
  public item!: SNNote
  public dealloced = false
  public isTemplateNote = false
  public runtimeId = `${Math.random()}`
  public needsInit = true

  private innerValueChangeObservers: ((note: SNNote, source: PayloadEmitSource) => void)[] = []
  private disposers: (() => void)[] = []
  private defaultTagUuid: UuidString | undefined
  private defaultTag?: SNTag

  private syncController!: NoteSyncController

  // Standard Red Notes (achievements): per-note edit counter for the lifetime of
  // this controller. Each save bumps it; we feed the running count to the
  // achievements service's setAtLeast so the "max edits on a single note" metric
  // reflects the most-edited note. Web-local, fire-and-forget.
  private editCountForThisNote = 0

  constructor(
    item: SNNote | undefined,
    private items: ItemManagerInterface,
    private mutator: MutatorClientInterface,
    private sync: SyncServiceInterface,
    private sessions: SessionsClientInterface,
    private preferences: PreferenceServiceInterface,
    private components: ComponentManagerInterface,
    private alerts: AlertService,
    private _isNativeMobileWeb: IsNativeMobileWeb,
    public templateNoteOptions?: TemplateNoteViewControllerOptions,
  ) {
    if (item) {
      this.item = item
    }

    if (templateNoteOptions) {
      this.defaultTagUuid = templateNoteOptions.tag
    }

    if (this.defaultTagUuid) {
      this.defaultTag = this.items.findItem(this.defaultTagUuid) as SNTag
    }

    this.syncController = new NoteSyncController(
      this.item,
      this.items,
      this.mutator,
      this.sessions,
      this.sync,
      this.alerts,
      this._isNativeMobileWeb,
    )
  }

  deinit(): void {
    if (!this.syncController.savingLocallyPromise) {
      this.performDeinitSafely()
      return
    }

    void this.syncController.savingLocallyPromise.promise.then(() => {
      this.performDeinitSafely()
    })
  }

  private performDeinitSafely(): void {
    this.dealloced = true

    for (const disposer of this.disposers) {
      disposer()
    }
    this.disposers.length = 0
    this.innerValueChangeObservers.length = 0
  }

  async initialize(): Promise<void> {
    if (!this.needsInit) {
      throw Error('NoteViewController already initialized')
    }

    log(LoggingDomain.NoteView, 'Initializing NoteViewController')

    this.needsInit = false

    /**
     * LAZY-DECRYPT (flag-gated) editor-open re-hydration. With the flag on, the
     * note may be a content-stripped "lite" item (body dropped on cold-load). The
     * editor must edit/save against the REAL body, and the safety guard refuses to
     * mutate a lite payload — so re-hydrate the full content from IndexedDB and emit
     * it back into state BEFORE the editor reads `text`. The streamItems observer
     * below then picks up the now-full note and updates `this.item`. With the flag
     * off no item is ever lite, so this is a no-op (byte-identical behavior).
     */
    await this.rehydrateLiteNoteIfNeeded()

    const shouldAddTagHierarchy = this.preferences.getValue(PrefKey.NoteAddToParentFolders, true)

    if (!this.item) {
      log(LoggingDomain.NoteView, 'Initializing as template note')

      const editorIdentifier = this.components.getDefaultEditorIdentifier(this.defaultTag)

      const noteType = noteTypeForEditorIdentifier(editorIdentifier)

      const note = this.items.createTemplateItem<NoteContent, SNNote>(
        ContentType.TYPES.Note,
        {
          text: '',
          title: this.templateNoteOptions?.title || '',
          noteType: noteType,
          editorIdentifier: editorIdentifier,
          references: [],
        },
        {
          created_at: this.templateNoteOptions?.createdAt || new Date(),
          ...PayloadVaultOverrides(this.templateNoteOptions?.vault),
        },
      )

      this.isTemplateNote = true
      this.item = note
      this.syncController.setItem(this.item)

      if (this.defaultTagUuid) {
        const tag = this.items.findItem(this.defaultTagUuid) as SNTag
        await this.mutator.addTagToNote(note, tag, shouldAddTagHierarchy)
      }

      this.notifyObservers(this.item, PayloadEmitSource.InitialObserverRegistrationPush)
    }

    this.streamItems()
  }

  /**
   * If the controller's note is a lazy-decrypt "lite" item (body stripped on
   * cold-load), re-hydrate its full content from IndexedDB and emit it back into
   * state so the editor opens against the real body. No-op when the note is full
   * (always the case with the flag off) or when re-hydration fails (the editor then
   * opens against the lite note and a later edit would be guarded — but in practice
   * the on-disk payload is present, so this succeeds).
   */
  private async rehydrateLiteNoteIfNeeded(): Promise<void> {
    if (!this.item || !isLitePayload(this.item.payload)) {
      return
    }

    const full = await this.sync.getFullContentPayload(this.item.uuid)
    if (!full || isLitePayload(full)) {
      return
    }

    const emitted = await this.mutator.emitItemFromPayload(full, PayloadEmitSource.LocalDatabaseLoaded)
    this.item = emitted as SNNote
    this.syncController.setItem(this.item)
  }

  private notifyObservers(note: SNNote, source: PayloadEmitSource): void {
    for (const observer of this.innerValueChangeObservers) {
      observer(note, source)
    }
  }

  private streamItems() {
    if (this.dealloced) {
      return
    }

    this.disposers.push(
      this.items.streamItems<SNNote>(ContentType.TYPES.Note, ({ changed, inserted, source }) => {
        if (this.dealloced) {
          return
        }

        const notes = changed.concat(inserted)

        const matchingNote = notes.find((item) => {
          return item.uuid === this.item.uuid
        })

        if (matchingNote) {
          this.isTemplateNote = false
          this.item = matchingNote
          this.notifyObservers(matchingNote, source)
        }
      }),
    )
  }

  public insertTemplatedNote(): Promise<DecryptedItemInterface> {
    log(LoggingDomain.NoteView, 'Inserting template note')
    this.isTemplateNote = false
    // Achievements: count newly-created spreadsheet notes (web-local, best-effort).
    if (this.item?.noteType === NoteType.Spreadsheet) {
      achievements.increment(METRICS.spreadsheetNotesCreated)
    }
    return this.mutator.insertItem(this.item)
  }

  /**
   * Register to be notified when the controller's note's inner values change
   * (and thus a new object reference is created)
   */
  public addNoteInnerValueChangeObserver(callback: (note: SNNote, source: PayloadEmitSource) => void): () => void {
    this.innerValueChangeObservers.push(callback)

    if (this.item) {
      callback(this.item, PayloadEmitSource.InitialObserverRegistrationPush)
    }

    const thislessChangeObservers = this.innerValueChangeObservers
    return () => {
      removeFromArray(thislessChangeObservers, callback)
    }
  }

  public async saveAndAwaitLocalPropagation(params: NoteSaveFunctionParams): Promise<void> {
    if (this.needsInit) {
      throw Error('NoteViewController not initialized')
    }

    log(LoggingDomain.NoteView, 'Saving note', params)

    const isTemplate = this.isTemplateNote

    if (isTemplate) {
      await this.insertTemplatedNote()
    }

    // Achievements: each save is one "edit" of this note. Feed the running count
    // for THIS note to setAtLeast so the metric tracks the most-edited note.
    this.editCountForThisNote += 1
    achievements.setAtLeast(METRICS.maxNoteEdits, this.editCountForThisNote)

    await this.syncController.saveAndAwaitLocalPropagation(params)
  }

  public get syncStatus(): NoteStatus | undefined {
    return this.syncController.status
  }

  public showSavingStatus(): void {
    this.syncController.showSavingStatus()
  }

  public showAllChangesSavedStatus(): void {
    this.syncController.showAllChangesSavedStatus()
  }

  public showErrorSyncStatus(error?: NoteStatus): void {
    this.syncController.showErrorStatus(error)
  }

  public syncNow(): void {
    this.sync.sync().catch(console.error)
  }

  public syncOnlyIfLargeNote(): void {
    this.syncController.syncOnlyIfLargeNote()
  }
}

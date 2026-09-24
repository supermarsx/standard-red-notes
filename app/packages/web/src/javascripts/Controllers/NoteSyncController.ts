import { MutationType, NoteMutator, SNNote } from '@standardnotes/models'
import {
  AlertService,
  ContentType,
  InfoStrings,
  ItemManagerInterface,
  MutatorClientInterface,
  SessionsClientInterface,
  SyncMode,
  SyncServiceInterface,
} from '@standardnotes/snjs'
import { Deferred } from '@standardnotes/utils'
import { EditorSaveTimeoutDebounce } from '../Components/NoteView/Controller/EditorSaveTimeoutDebounce'
import { IsNativeMobileWeb } from '@standardnotes/ui-services'
import { LargeNoteThreshold } from '@/Constants/Constants'
import { NoteStatus } from '@/Components/NoteView/NoteStatusIndicator'
import { action, makeObservable, observable, runInAction } from 'mobx'

const NotePreviewCharLimit = 160
const MinimumStatusChangeDuration = 400

export type NoteSaveFunctionParams = {
  title?: string
  text?: string
  bypassDebouncer?: boolean
  isUserModified?: boolean
  dontGeneratePreviews?: boolean
  previews?: { previewPlain: string; previewHtml?: string }
  customMutate?: (mutator: NoteMutator) => void
  onLocalPropagationComplete?: () => void
}

type SaveOperation = {
  completion: ReturnType<typeof Deferred<void>>
  timeout?: ReturnType<typeof setTimeout>
}

type StrictSaveDrain = {
  promise: Promise<void>
  resolve: () => void
  reject: (reason?: unknown) => void
}

function createStrictSaveDrain(): StrictSaveDrain {
  let resolve!: () => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

export class NoteSyncController {
  savingLocallyPromise: ReturnType<typeof Deferred<void>> | null = null

  private strictSavingLocallyPromise: StrictSaveDrain | null = null
  private lastStrictLocalPropagationPromise: Promise<void> = Promise.resolve()
  private localSaveDrainFailed = false
  private localSaveDrainError: unknown
  private queuedSaveOperation?: SaveOperation
  private saveOperations = new Set<SaveOperation>()
  private largeNoteSyncTimeout?: ReturnType<typeof setTimeout>
  private statusChangeTimeout?: ReturnType<typeof setTimeout>
  private deallocated = false
  /**
   * Standard Red Notes (work-preservation): set once `undebouncedMutateAndSync` discovers this
   * controller's item has been discarded from the item store (a server-asserted deletion was
   * applied -- see t97 investigation, no other removal path exists). From that point the note
   * can never save again, so every further status change and save attempt is refused instead of
   * silently pretending the (dead) editor is still live.
   */
  private noteIsGone = false

  status: NoteStatus | undefined = undefined

  constructor(
    private item: SNNote,
    private items: ItemManagerInterface,
    private mutator: MutatorClientInterface,
    private sessions: SessionsClientInterface,
    private sync: SyncServiceInterface,
    private alerts: AlertService,
    private _isNativeMobileWeb: IsNativeMobileWeb,
  ) {
    makeObservable(this, {
      status: observable,
      setStatus: action,
    })
  }

  setStatus(status: NoteStatus, wait = true) {
    /**
     * Standard Red Notes (work-preservation): once the note is confirmed gone, the status stays
     * pinned at whatever `markNoteAsGone` set it to. Without this, NoteView's per-keystroke
     * showSavingStatus()/showAllChangesSavedStatus() calls (which do not go through the save
     * guard below) would keep flickering "Saving…"/"All changes saved" for a note that can never
     * save again.
     */
    if (this.noteIsGone) {
      return
    }
    if (this.statusChangeTimeout) {
      clearTimeout(this.statusChangeTimeout)
    }
    if (wait) {
      this.statusChangeTimeout = setTimeout(() => {
        runInAction(() => {
          this.status = status
        })
      }, MinimumStatusChangeDuration)
    } else {
      this.status = status
    }
  }

  showSavingStatus() {
    this.setStatus(
      {
        type: 'saving',
        message: 'Saving…',
      },
      false,
    )
  }

  showAllChangesSavedStatus() {
    this.setStatus({
      type: 'saved',
      message: 'All changes saved' + (this.sessions.isSignedOut() ? ' offline' : ''),
    })
  }

  showWaitingToSyncLargeNoteStatus() {
    this.setStatus(
      {
        type: 'waiting',
        message: 'Note is too large',
        description: 'It will be synced less often. Changes will be saved offline normally.',
      },
      false,
    )
  }

  showErrorStatus(error?: NoteStatus) {
    if (!error) {
      error = {
        type: 'error',
        message: 'Sync Unreachable',
        description: 'Changes saved offline',
      }
    }
    this.setStatus(error)
  }

  setItem(item: SNNote) {
    this.item = item
  }

  deinit() {
    this.deallocated = true
    this.cancelQueuedSave()
    if (this.largeNoteSyncTimeout) {
      clearTimeout(this.largeNoteSyncTimeout)
    }
    if (this.statusChangeTimeout) {
      clearTimeout(this.statusChangeTimeout)
    }
    for (const operation of [...this.saveOperations]) {
      this.settleSaveOperation(operation)
    }
    this.savingLocallyPromise = null
    this.strictSavingLocallyPromise = null
    this.lastStrictLocalPropagationPromise = Promise.resolve()
    this.localSaveDrainFailed = false
    this.localSaveDrainError = undefined
    this.largeNoteSyncTimeout = undefined
    this.status = undefined
    this.statusChangeTimeout = undefined
    this.noteIsGone = false
    ;(this.item as unknown) = undefined
  }

  private settleSaveOperation(operation: SaveOperation, failure?: { error: unknown }): void {
    if (failure && !this.localSaveDrainFailed) {
      this.localSaveDrainFailed = true
      this.localSaveDrainError = failure.error
    }
    if (operation.timeout !== undefined) {
      clearTimeout(operation.timeout)
      operation.timeout = undefined
    }

    operation.completion.resolve()
    this.saveOperations.delete(operation)

    if (this.queuedSaveOperation === operation) {
      this.queuedSaveOperation = undefined
    }
    if (this.saveOperations.size === 0 && this.savingLocallyPromise) {
      this.savingLocallyPromise.resolve()
      this.savingLocallyPromise = null
      const strictDrain = this.strictSavingLocallyPromise
      this.strictSavingLocallyPromise = null
      if (strictDrain) {
        if (this.localSaveDrainFailed) {
          strictDrain.reject(this.localSaveDrainError)
        } else {
          strictDrain.resolve()
        }
      }
      this.localSaveDrainFailed = false
      this.localSaveDrainError = undefined
    }
  }

  private cancelQueuedSave(): void {
    const queued = this.queuedSaveOperation
    if (queued) {
      this.settleSaveOperation(queued)
    }
  }

  private isLargeNote(text: string): boolean {
    const textByteSize = new Blob([text]).size
    return textByteSize > LargeNoteThreshold
  }

  public async saveAndAwaitLocalPropagation(params: NoteSaveFunctionParams): Promise<void> {
    /**
     * Standard Red Notes (last-edit-loss fix — dealloced guard): a lifecycle flush
     * (note-switch/unmount/logout/beforeunload) can arrive AFTER deinit() has nulled
     * `this.item`. Without this guard the subsequent `this.item.text`/changeItem
     * access throws and the in-flight edit is silently lost. After deinit, `item` is
     * undefined — treat a post-deinit save as a safe NO-OP instead of throwing.
     */
    if (this.deallocated || (this.item as unknown) === undefined) {
      return
    }

    /**
     * Standard Red Notes (work-preservation): once markNoteAsGone has fired, this note can never
     * save again (its uuid was discarded). Refuse to even queue further attempts instead of
     * scheduling a debounced save that will just re-discover the same dead uuid 700ms later.
     */
    if (this.noteIsGone) {
      return
    }

    const supersededOperation = this.queuedSaveOperation
    const operation: SaveOperation = { completion: Deferred<void>() }
    if (!this.savingLocallyPromise) {
      // This deferred represents the complete drain of all overlapping local
      // operations. Ordinary controller teardown waits on it, so a newer save
      // cannot make an older in-flight mutation invisible to the lifecycle.
      this.savingLocallyPromise = Deferred<void>()
      this.strictSavingLocallyPromise = createStrictSaveDrain()
      this.lastStrictLocalPropagationPromise = this.strictSavingLocallyPromise.promise
      // The strict channel is consumed only by explicit durability boundaries.
      // Attach a handler immediately so an ordinary editor save cannot create an
      // unhandled rejection while preserving the original rejecting promise.
      void this.lastStrictLocalPropagationPromise.catch(() => undefined)
    }
    this.saveOperations.add(operation)
    this.queuedSaveOperation = operation

    // Register the replacement before settling the superseded debounce so the
    // aggregate lifecycle drain can never transiently reach zero. Otherwise an
    // already-waiting ordinary deinit can resume and cancel the newest edit.
    if (supersededOperation) {
      this.settleSaveOperation(supersededOperation)
    }

    const noDebounce = params.bypassDebouncer || this.sessions.isSignedOut()
    const syncDebounceMs = noDebounce
      ? EditorSaveTimeoutDebounce.ImmediateChange
      : this._isNativeMobileWeb.execute().getValue()
        ? EditorSaveTimeoutDebounce.NativeMobileWeb
        : EditorSaveTimeoutDebounce.Desktop

    const isLargeNote = this.isLargeNote(params.text ?? this.item.text)

    if (isLargeNote) {
      this.showWaitingToSyncLargeNoteStatus()
    }

    operation.timeout = setTimeout(() => {
      operation.timeout = undefined
      if (this.queuedSaveOperation === operation) {
        this.queuedSaveOperation = undefined
      }

      if (this.deallocated) {
        this.settleSaveOperation(operation)
        return
      }

      void this.undebouncedMutateAndSync({
        ...params,
        localOnly: isLargeNote,
        onLocalPropagationComplete: () => {
          if (!this.deallocated) {
            params.onLocalPropagationComplete?.()
          }
          this.settleSaveOperation(operation)
        },
      }).catch((error) => {
        console.error(error)
        this.settleSaveOperation(operation, { error })
      })
    }, syncDebounceMs)

    return operation.completion.promise
  }

  /** Rejects for the real outcome of the newest local-save drain. */
  public awaitCurrentLocalPropagationStrict(): Promise<void> {
    return this.strictSavingLocallyPromise?.promise ?? this.lastStrictLocalPropagationPromise
  }

  /**
   * Standard Red Notes (work-preservation, t97): the only way `findItem` stops resolving this
   * controller's uuid is a server-asserted deletion being applied (confirmed by investigation --
   * there is no false-positive removal path). Report that honestly, point the user at the
   * automatic conflict-copy the sync engine already created for any text that was unsynced at
   * the moment of deletion (see GenericItem.strategyWhenConflictingWithItem ->
   * ConflictStrategy.DuplicateBaseKeepApply, handled in Conflict.ts) when one exists, and
   * permanently stop this controller from pretending further edits are being saved.
   *
   * Deliberately does NOT create a rescue note itself: when the sync engine already made one,
   * creating another would strand the user with two divergent copies, which is worse than the
   * bug. When it did not (the note was clean at the moment of deletion, so there was nothing to
   * preserve), there is nothing to point at either.
   */
  private handleNoteDiscoveredGone(): void {
    if (this.noteIsGone) {
      return
    }

    const rescueCopy = this.findConflictCopyOfDiscoveredNote()

    const message = rescueCopy
      ? `${InfoStrings.NoteDeletedRemotely} The text you had not yet saved was automatically kept as a new note titled "${rescueCopy.title || 'Untitled'}". Further changes made in this editor will not be saved.`
      : `${InfoStrings.NoteDeletedRemotely} Further changes made in this editor will not be saved.`

    this.setStatus(
      {
        type: 'error',
        message: 'Note deleted',
        description: message,
      },
      false,
    )
    this.noteIsGone = true

    void this.alerts.alert(message, 'Note deleted')
  }

  /**
   * The item-store's own conflict index (`ItemManagerInterface.conflictsOf`) cannot be used
   * here: discarding an item scrubs its own entries from that index (Collection.discard ->
   * conflictMap.removeFromMap), which erases the very relationship that gets established when
   * the rescue copy is inserted in the same sync batch that discards the original. Scanning by
   * the copy's own `conflictOf` content field is unaffected by that bookkeeping and finds it
   * reliably. Ties (more than one historical conflict copy of the same uuid) resolve to the
   * most recently updated one.
   */
  private findConflictCopyOfDiscoveredNote(): SNNote | undefined {
    const candidates = this.items
      .getItems<SNNote>(ContentType.TYPES.Note)
      .filter((note) => note.conflictOf === this.item.uuid)

    if (candidates.length === 0) {
      return undefined
    }

    return candidates.reduce((newest, candidate) =>
      (candidate.updated_at?.getTime() ?? 0) > (newest.updated_at?.getTime() ?? 0) ? candidate : newest,
    )
  }

  private queueLargeNoteSyncIfNeeded(): void {
    if (this.deallocated) {
      return
    }

    const isAlreadyAQueuedLargeNoteSync = this.largeNoteSyncTimeout !== undefined

    if (!isAlreadyAQueuedLargeNoteSync) {
      const isSignedIn = this.sessions.isSignedIn()
      const timeout = isSignedIn ? EditorSaveTimeoutDebounce.LargeNote : EditorSaveTimeoutDebounce.ImmediateChange

      this.largeNoteSyncTimeout = setTimeout(() => {
        this.largeNoteSyncTimeout = undefined
        void this.performSyncOfLargeItem()
      }, timeout)
    }
  }

  private async performSyncOfLargeItem(): Promise<void> {
    if (this.deallocated || (this.item as unknown) === undefined) {
      return
    }

    const item = this.items.findItem(this.item.uuid)
    if (!item || !item.dirty) {
      return
    }

    void this.sync.sync()
  }

  private async undebouncedMutateAndSync(params: NoteSaveFunctionParams & { localOnly: boolean }): Promise<void> {
    if (!this.items.findItem(this.item.uuid)) {
      this.handleNoteDiscoveredGone()
      /**
       * Standard Red Notes (hang fix): resolve the save promise before bailing.
       * Without this the resolver wired in saveAndAwaitLocalPropagation
       * (onLocalPropagationComplete) never runs, so `savingLocallyPromise` never
       * resolves and any note-switch/deinit awaiting it hangs and leaks.
       */
      params.onLocalPropagationComplete?.()
      return
    }

    await this.mutator.changeItem(
      this.item,
      (mutator) => {
        // A mutator implementation can defer invoking this callback. Once a
        // security teardown crosses the boundary, never write the retained
        // plaintext even if an already-started changeItem call resumes later.
        if (this.deallocated) {
          return
        }

        const noteMutator = mutator as NoteMutator
        if (params.customMutate) {
          params.customMutate(noteMutator)
        }

        if (params.title != undefined) {
          noteMutator.title = params.title
        }

        if (params.text != undefined) {
          noteMutator.text = params.text
        }

        if (params.previews) {
          noteMutator.preview_plain = params.previews.previewPlain
          noteMutator.preview_html = params.previews.previewHtml
        } else if (!params.dontGeneratePreviews && params.text != undefined) {
          const noteText = params.text || ''
          const truncate = noteText.length > NotePreviewCharLimit
          const substring = noteText.substring(0, NotePreviewCharLimit)
          const previewPlain = substring + (truncate ? '...' : '')
          noteMutator.preview_plain = previewPlain
          noteMutator.preview_html = undefined
        }
      },
      params.isUserModified ? MutationType.UpdateUserTimestamps : MutationType.NoUpdateUserTimestamps,
    )

    if (this.deallocated) {
      return
    }

    void this.sync.sync({ mode: params.localOnly ? SyncMode.LocalOnly : undefined })

    this.queueLargeNoteSyncIfNeeded()

    params.onLocalPropagationComplete?.()
  }

  public syncOnlyIfLargeNote(): void {
    if (this.deallocated || (this.item as unknown) === undefined) {
      return
    }

    const isLargeNote = this.isLargeNote(this.item.text)
    if (isLargeNote) {
      void this.performSyncOfLargeItem()
    }
  }
}

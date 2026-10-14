import { ApplicationEvent, ContentType, PrefKey, RecentNoteEntry, SNNote } from '@standardnotes/snjs'
import { action, makeObservable, observable, runInAction } from 'mobx'
import { WebApplication } from '@/Application/WebApplication'

/**
 * Standard Red Notes: how many distinct notes the recently-opened history keeps.
 */
export const MAX_RECENT_NOTES = 25

/**
 * Standard Red Notes: a single resolved recent-notes row, suitable for rendering.
 * `note` is undefined when the underlying note has been deleted/trashed or is not
 * (yet) loaded, so the UI can render a "(deleted)" placeholder.
 */
export type ResolvedRecentNote = {
  uuid: string
  openedAt: number
  note: SNNote | undefined
}

/**
 * Tracks the notes the user has recently opened, most-recent-first, and persists
 * the list to the RecentNotesHistory preference so it survives reloads and follows
 * the user across devices.
 *
 * ItemGroupController owns plain controller references, so subscribe to its
 * committed active-controller notification rather than caching a MobX computed
 * with no observable dependencies. No note content or editor state is changed.
 */
export class RecentNotesState {
  entries: RecentNoteEntry[] = []
  recordingEnabled = true
  historyLimit = MAX_RECENT_NOTES

  private readonly disposers: (() => void)[] = []
  private activeNoteUuid?: string

  constructor(private application: WebApplication) {
    makeObservable(this, {
      entries: observable,
      recordingEnabled: observable,
      historyLimit: observable,
      setEntries: action,
      clear: action,
    })

    this.refreshPreferences()
    this.disposers.push(
      application.itemControllerGroup.addActiveControllerChangeObserver((controller) => {
        const item = controller?.item
        const uuid = item?.content_type === ContentType.TYPES.Note ? item.uuid : undefined
        if (uuid === this.activeNoteUuid) {
          return
        }
        this.activeNoteUuid = uuid
        if (uuid && this.recordingEnabled && application.sync.isDatabaseLoaded()) {
          this.recordOpenedNote(uuid)
        }
      }),
      application.addEventObserver(async () => this.refreshPreferences(), ApplicationEvent.PreferencesChanged),
      application.addEventObserver(async () => {
        this.refreshPreferences()
        if (this.activeNoteUuid && this.recordingEnabled) {
          this.recordOpenedNote(this.activeNoteUuid)
        }
      }, ApplicationEvent.LocalDataLoaded),
    )
  }

  deinit(): void {
    this.disposers.splice(0).forEach((dispose) => dispose())
    ;(this.application as unknown) = undefined
  }

  setEntries(entries: RecentNoteEntry[]): void {
    this.entries = entries
  }

  private refreshPreferences(): void {
    const configuredLimit = this.application.getPreference(PrefKey.RecentNotesHistoryLimit, MAX_RECENT_NOTES)
    runInAction(() => {
      this.recordingEnabled = this.application.getPreference(PrefKey.RecentNotesRecordingEnabled, true) !== false
      this.historyLimit =
        Number.isSafeInteger(configuredLimit) && configuredLimit >= 1 && configuredLimit <= 100
          ? configuredLimit
          : MAX_RECENT_NOTES
      this.setEntries(this.readFromPreferences().slice(0, this.historyLimit))
    })
  }

  async setRecordingEnabled(enabled: boolean): Promise<void> {
    runInAction(() => {
      this.recordingEnabled = enabled
    })
    await this.application.setPreference(PrefKey.RecentNotesRecordingEnabled, enabled)
  }

  async setHistoryLimit(limit: number): Promise<void> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return
    }
    runInAction(() => {
      this.historyLimit = limit
      this.setEntries(this.entries.slice(0, limit))
    })
    await this.application.setPreference(PrefKey.RecentNotesHistoryLimit, limit)
    this.persist(this.entries)
  }

  private readFromPreferences(): RecentNoteEntry[] {
    const stored = this.application.getPreference(PrefKey.RecentNotesHistory, [])
    if (!Array.isArray(stored)) {
      return []
    }
    // Defensive: ignore malformed entries that may have been written by an older
    // build or a corrupted preference value.
    return stored.filter(
      (entry): entry is RecentNoteEntry =>
        !!entry && typeof entry.uuid === 'string' && typeof entry.openedAt === 'number',
    )
  }

  private persist(entries: RecentNoteEntry[]): void {
    void this.application.setPreference(PrefKey.RecentNotesHistory, entries)
  }

  private recordOpenedNote(uuid: string): void {
    const now = Date.now()
    const existing = this.entries.filter((entry) => entry.uuid !== uuid)
    const next = [{ uuid, openedAt: now }, ...existing].slice(0, this.historyLimit)
    runInAction(() => {
      this.setEntries(next)
    })
    this.persist(next)
  }

  /**
   * Resolves each stored entry against the current item store so the UI can render
   * titles and detect deleted/missing notes. Entries are returned in stored order
   * (most-recent-first).
   */
  get resolvedNotes(): ResolvedRecentNote[] {
    return this.entries.map((entry) => {
      // findItem only returns live (non-deleted) items, so a missing item here
      // means the note was deleted. Trashed notes are also treated as unavailable.
      const note = this.application.items.findItem<SNNote>(entry.uuid)
      const isAvailable = !!note && !note.trashed
      return {
        uuid: entry.uuid,
        openedAt: entry.openedAt,
        note: isAvailable ? note : undefined,
      }
    })
  }

  clear(): void {
    this.setEntries([])
    this.persist([])
  }
}

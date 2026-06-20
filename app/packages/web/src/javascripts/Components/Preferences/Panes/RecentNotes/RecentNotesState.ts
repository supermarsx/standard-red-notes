import { ContentType, PrefKey, RecentNoteEntry, SNNote } from '@standardnotes/snjs'
import { action, makeObservable, observable, reaction, runInAction } from 'mobx'
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
 * This is intentionally a READ-ONLY observer of the rest of the app: it watches the
 * active item controller's note via a mobx reaction and never mutates the
 * ItemList/NoteView controllers. The reaction fires whenever the active note
 * changes (i.e. a note is opened), which is the cleanest "a note was opened" signal
 * available without editing those controllers.
 */
export class RecentNotesState {
  entries: RecentNoteEntry[] = []

  private disposeReaction?: () => void

  constructor(private application: WebApplication) {
    makeObservable(this, {
      entries: observable,
      setEntries: action,
      clear: action,
    })

    this.entries = this.readFromPreferences()

    // Observe the active note. `activeControllerItem` is a mobx computed, so this
    // reaction re-runs each time the user opens/switches to a different note.
    this.disposeReaction = reaction(
      () => {
        const active = this.application.itemListController?.activeControllerItem
        if (!active || active.content_type !== ContentType.TYPES.Note) {
          return undefined
        }
        return active.uuid
      },
      (uuid) => {
        if (uuid) {
          this.recordOpenedNote(uuid)
        }
      },
      { fireImmediately: true },
    )
  }

  deinit(): void {
    this.disposeReaction?.()
    this.disposeReaction = undefined
    ;(this.application as unknown) = undefined
  }

  setEntries(entries: RecentNoteEntry[]): void {
    this.entries = entries
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
    const next = [{ uuid, openedAt: now }, ...existing].slice(0, MAX_RECENT_NOTES)
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

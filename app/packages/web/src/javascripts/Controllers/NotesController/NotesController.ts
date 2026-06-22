import { destroyAllObjectProperties } from '@/Utils'
import {
  confirmDialog,
  GetItemTags,
  IsGlobalSpellcheckEnabled,
  PIN_NOTE_COMMAND,
  STAR_NOTE_COMMAND,
} from '@standardnotes/ui-services'
import { StringEmptyTrash, Strings, StringUtils } from '@/Constants/Strings'
import {
  SNNote,
  NoteMutator,
  ContentType,
  SNTag,
  PrefKey,
  ApplicationEvent,
  EditorLineWidth,
  MutationType,
  PrefDefaults,
  InternalEventHandlerInterface,
  InternalEventInterface,
  LocalPrefKey,
  NoteContent,
  noteTypeForEditorIdentifier,
  ContentReference,
  pluralize,
  NoteType,
  NativeFeatureIdentifier,
} from '@standardnotes/snjs'
import { NotePart, SplitNoteOptions, splitNoteContent } from '../../Utils/NoteSplitting/splitNoteContent'
import { makeObservable, observable, action, computed, runInAction, reaction } from 'mobx'
import { AbstractViewController } from '../Abstract/AbstractViewController'
import { NotesControllerInterface } from './NotesControllerInterface'
import { CrossControllerEvent } from '../CrossControllerEvent'
import { addToast, dismissToast, ToastType } from '@standardnotes/toast'
import { createNoteExport } from '../../Utils/NoteExportUtils'
import { NoteCustomBackgroundColorKey, NoteCustomTextColorKey } from '../../Utils/NoteAppearance'
import {
  NoteHeroHeaderKey,
  HeroHeader,
  getNoteHeroHeader,
  clampHeroHeight,
  clampHeroFocalY,
  normalizeHeroImageDataUrl,
} from '../../HeroHeader/heroHeader'
import {
  NoteRemindersKey,
  Reminder,
  getNoteReminders,
  upsertReminder as upsertReminderInList,
  removeReminder as removeReminderFromList,
  markReminderNotified as markReminderNotifiedInList,
  advanceRecurringReminder,
  isRecurring,
} from '../../Reminders/reminders'
import {
  NoteBookmarksKey,
  Bookmark,
  getNoteBookmarks,
  upsertBookmark as upsertBookmarkInList,
  removeBookmark as removeBookmarkFromList,
  updateBookmark as updateBookmarkInList,
} from '../../Bookmarks/bookmarks'
import { NoteIsTemplateKey, noteIsTemplate } from '../../Templates/templates'
import { WebApplication } from '../../Application/WebApplication'
import { downloadOrShareBlobBasedOnPlatform } from '../../Utils/DownloadOrShareBasedOnPlatform'

export class NotesController
  extends AbstractViewController
  implements NotesControllerInterface, InternalEventHandlerInterface
{
  shouldLinkToParentFolders: boolean
  lastSelectedNote: SNNote | undefined
  contextMenuOpen = false
  contextMenuClickLocation: { x: number; y: number } = { x: 0, y: 0 }
  contextMenuMaxHeight: number | 'auto' = 'auto'
  showProtectedWarning = false
  shouldShowSuperExportModal = false

  commandRegisterDisposers: (() => void)[] = []

  constructor(
    private application: WebApplication,
    private _isGlobalSpellcheckEnabled: IsGlobalSpellcheckEnabled,
    private _getItemTags: GetItemTags,
  ) {
    super(application.events)

    makeObservable(this, {
      contextMenuOpen: observable,
      showProtectedWarning: observable,
      shouldShowSuperExportModal: observable,

      selectedNotes: computed,
      firstSelectedNote: computed,
      selectedNotesCount: computed,
      trashedNotesCount: computed,

      setContextMenuOpen: action,
      setContextMenuClickLocation: action,
      setShowProtectedWarning: action,
      unselectNotes: action,
      showSuperExportModal: action,
      closeSuperExportModal: action,
    })

    this.shouldLinkToParentFolders = application.preferences.getValue(
      PrefKey.NoteAddToParentFolders,
      PrefDefaults[PrefKey.NoteAddToParentFolders],
    )

    application.events.addEventHandler(this, ApplicationEvent.PreferencesChanged)
    application.events.addEventHandler(this, CrossControllerEvent.UnselectAllNotes)

    this.disposers.push(
      reaction(
        () => this.selectedNotesCount,
        (notes_count) => {
          this.disposeCommandRegisters()

          const descriptionSuffix = `${pluralize(notes_count, 'current', 'selected')} ${pluralize(
            notes_count,
            'note',
            'note(s)',
          )}`

          this.commandRegisterDisposers.push(
            application.commands.add(
              'pin-current',
              `Pin ${descriptionSuffix}`,
              () => this.setPinSelectedNotes(true),
              'unpin',
            ),
            application.commands.add(
              'unpin-current',
              `Unpin ${descriptionSuffix}`,
              () => this.setPinSelectedNotes(false),
              'pin',
            ),
            application.commands.add(
              'star-current',
              `Star ${descriptionSuffix}`,
              () => this.setStarSelectedNotes(true),
              'star',
            ),
            application.commands.add(
              'unstar-current',
              `Unstar ${descriptionSuffix}`,
              () => this.setStarSelectedNotes(false),
              'star',
            ),
            application.commands.add(
              'archive-current',
              `Archive ${descriptionSuffix}`,
              () => this.setArchiveSelectedNotes(true),
              'archive',
            ),
            application.commands.add(
              'unarchive-current',
              `Unarchive ${descriptionSuffix}`,
              () => this.setArchiveSelectedNotes(false),
              'unarchive',
            ),
            application.commands.add(
              'restore-current',
              `Restore ${descriptionSuffix}`,
              () => this.setTrashSelectedNotes(false),
              'restore',
            ),
            application.commands.add(
              'trash-current',
              `Trash ${descriptionSuffix}`,
              () => this.setTrashSelectedNotes(true),
              'trash',
            ),
            application.commands.add(
              'delete-current',
              `Delete ${descriptionSuffix} permanently`,
              () => this.deleteNotesPermanently(),
              'trash',
            ),
            application.commands.add(
              'export-current',
              `Export ${descriptionSuffix}`,
              this.exportSelectedNotes,
              'download',
            ),
            application.commands.add(
              'duplicate-current',
              `Duplicate ${descriptionSuffix}`,
              this.duplicateSelectedNotes,
              'copy',
            ),
          )
        },
      ),
    )

    this.disposers.push(
      application.keyboardService.addCommandHandler({
        command: PIN_NOTE_COMMAND,
        category: 'Current note',
        description: 'Pin/unpin selected note(s)',
        onKeyDown: this.togglePinSelectedNotes,
      }),
      application.keyboardService.addCommandHandler({
        command: STAR_NOTE_COMMAND,
        category: 'Current note',
        description: 'Star/unstar selected note(s)',
        onKeyDown: this.toggleStarSelectedNotes,
      }),
    )

    this.disposers.push(
      application.itemControllerGroup.addActiveControllerChangeObserver(() => {
        const controllers = application.itemControllerGroup.itemControllers

        const activeNoteUuids = controllers.map((controller) => controller.item.uuid)

        const selectedUuids = this.getSelectedNotesList().map((n) => n.uuid)

        for (const selectedId of selectedUuids) {
          if (!activeNoteUuids.includes(selectedId)) {
            application.itemListController.deselectItem({ uuid: selectedId })
          }
        }
      }),
    )
  }

  async handleEvent(event: InternalEventInterface): Promise<void> {
    if (event.type === ApplicationEvent.PreferencesChanged) {
      this.shouldLinkToParentFolders = this.application.preferences.getValue(
        PrefKey.NoteAddToParentFolders,
        PrefDefaults[PrefKey.NoteAddToParentFolders],
      )
    } else if (event.type === CrossControllerEvent.UnselectAllNotes) {
      this.unselectNotes()
    }
  }

  private disposeCommandRegisters() {
    if (this.commandRegisterDisposers.length > 0) {
      for (const dispose of this.commandRegisterDisposers) {
        dispose()
      }
    }
  }

  override deinit() {
    super.deinit()
    ;(this.lastSelectedNote as unknown) = undefined

    destroyAllObjectProperties(this)
  }

  public get selectedNotes(): SNNote[] {
    return this.application.itemListController.getFilteredSelectedItems<SNNote>(ContentType.TYPES.Note)
  }

  get firstSelectedNote(): SNNote | undefined {
    return Object.values(this.selectedNotes)[0]
  }

  get selectedNotesCount(): number {
    if (this.dealloced) {
      return 0
    }

    return Object.keys(this.selectedNotes).length
  }

  get trashedNotesCount(): number {
    return this.application.items.trashedItems.length
  }

  setContextMenuOpen = (open: boolean) => {
    this.contextMenuOpen = open
  }

  setContextMenuClickLocation(location: { x: number; y: number }): void {
    this.contextMenuClickLocation = location
  }

  async changeSelectedNotes(mutate: (mutator: NoteMutator) => void): Promise<void> {
    await this.application.mutator.changeItems(this.getSelectedNotesList(), mutate, MutationType.NoUpdateUserTimestamps)
    this.application.sync.sync().catch(console.error)
  }

  setHideSelectedNotePreviews(hide: boolean): void {
    this.changeSelectedNotes((mutator) => {
      mutator.hidePreview = hide
    }).catch(console.error)
  }

  setLockSelectedNotes(lock: boolean): void {
    this.changeSelectedNotes((mutator) => {
      mutator.locked = lock
    }).catch(console.error)
  }

  async setTrashSelectedNotes(trashed: boolean): Promise<void> {
    if (trashed) {
      const notesDeleted = await this.deleteNotes(false)
      if (notesDeleted) {
        runInAction(() => {
          this.contextMenuOpen = false
        })
      }
    } else {
      await this.changeSelectedNotes((mutator) => {
        mutator.trashed = trashed
      })
      runInAction(() => {
        this.contextMenuOpen = false
      })
    }
  }

  async deleteNotesPermanently(): Promise<void> {
    await this.deleteNotes(true)
  }

  async deleteNotes(permanently: boolean): Promise<boolean> {
    if (this.getSelectedNotesList().some((note) => note.locked)) {
      const text = StringUtils.deleteLockedNotesAttempt(this.selectedNotesCount)
      this.application.alerts.alert(text).catch(console.error)
      return false
    }

    const title = permanently ? Strings.deleteItemsPermanentlyTitle : Strings.trashItemsTitle
    let noteTitle = undefined
    if (this.selectedNotesCount === 1) {
      const selectedNote = this.getSelectedNotesList()[0]
      noteTitle = selectedNote.title.length ? `'${selectedNote.title}'` : 'this note'
    }
    const text = StringUtils.deleteNotes(permanently, this.selectedNotesCount, noteTitle)

    if (
      await confirmDialog({
        title,
        text,
        confirmButtonStyle: 'danger',
      })
    ) {
      this.application.itemListController.selectNextItem()
      if (permanently) {
        await this.application.mutator.deleteItems(this.getSelectedNotesList())
        void this.application.sync.sync()
      } else {
        await this.changeSelectedNotes((mutator) => {
          mutator.trashed = true
        })
      }
      return true
    }

    return false
  }

  togglePinSelectedNotes = () => {
    const notes = this.selectedNotes
    const pinned = notes.some((note) => note.pinned)

    if (!pinned) {
      this.setPinSelectedNotes(true)
    } else {
      this.setPinSelectedNotes(false)
    }
  }

  toggleStarSelectedNotes = () => {
    const notes = this.selectedNotes
    const starred = notes.some((note) => note.starred)

    if (!starred) {
      this.setStarSelectedNotes(true)
    } else {
      this.setStarSelectedNotes(false)
    }
  }

  setPinSelectedNotes(pinned: boolean): void {
    this.changeSelectedNotes((mutator) => {
      mutator.pinned = pinned
    }).catch(console.error)
  }

  setStarSelectedNotes(starred: boolean): void {
    this.changeSelectedNotes((mutator) => {
      mutator.starred = starred
    }).catch(console.error)
  }

  /**
   * Marks/unmarks the selected notes as "local only" (kept on this device, never synced).
   * Clearing the flag re-dirties the note so it uploads on the next sync.
   */
  setLocalOnlySelectedNotes(localOnly: boolean): void {
    this.changeSelectedNotes((mutator) => {
      mutator.localOnly = localOnly
    }).catch(console.error)
  }

  async toggleLocalOnlySelectedNotes(): Promise<void> {
    const notes = this.selectedNotes
    const anyLocalOnly = notes.some((note) => note.localOnly)
    this.setLocalOnlySelectedNotes(!anyLocalOnly)
  }

  async setArchiveSelectedNotes(archived: boolean): Promise<void> {
    if (this.getSelectedNotesList().some((note) => note.locked)) {
      this.application.alerts
        .alert(StringUtils.archiveLockedNotesAttempt(archived, this.selectedNotesCount))
        .catch(console.error)
      return
    }

    await this.changeSelectedNotes((mutator) => {
      mutator.archived = archived
    })

    runInAction(() => {
      this.application.itemListController.deselectAll()
      this.contextMenuOpen = false
    })
  }

  async toggleArchiveSelectedNotes(): Promise<void> {
    const notes = this.selectedNotes
    const archived = notes.some((note) => note.archived)

    if (!archived) {
      await this.setArchiveSelectedNotes(true)
    } else {
      await this.setArchiveSelectedNotes(false)
    }
  }

  async setProtectSelectedNotes(protect: boolean): Promise<void> {
    const selectedNotes = this.getSelectedNotesList()
    if (protect) {
      await this.application.protections.protectNotes(selectedNotes)
      this.setShowProtectedWarning(true)
    } else {
      await this.application.protections.unprotectNotes(selectedNotes)
      this.setShowProtectedWarning(false)
    }

    void this.application.sync.sync()
  }

  unselectNotes(): void {
    this.application.itemListController.deselectAll()
  }

  getSpellcheckStateForNote(note: SNNote) {
    return note.spellcheck != undefined ? note.spellcheck : this._isGlobalSpellcheckEnabled.execute().getValue()
  }

  async toggleGlobalSpellcheckForNote(note: SNNote) {
    await this.application.mutator.changeItem<NoteMutator>(
      note,
      (mutator) => {
        mutator.toggleSpellcheck()
      },
      MutationType.NoUpdateUserTimestamps,
    )
    this.application.sync.sync().catch(console.error)
  }

  getEditorWidthForNote(note: SNNote) {
    return (
      note.editorWidth ??
      this.application.preferences.getLocalValue(
        LocalPrefKey.EditorLineWidth,
        PrefDefaults[LocalPrefKey.EditorLineWidth],
      )
    )
  }

  async setNoteEditorWidth(note: SNNote, editorWidth: EditorLineWidth) {
    await this.application.mutator.changeItem<NoteMutator>(
      note,
      (mutator) => {
        mutator.editorWidth = editorWidth
      },
      MutationType.NoUpdateUserTimestamps,
    )
    this.application.sync.sync().catch(console.error)
  }

  /**
   * Standard Red Notes: per-note custom appearance. Background/text colors are
   * persisted in the note's encrypted appData (no models/server change). Passing
   * `undefined` for a color clears that override and reverts to theme defaults.
   */
  async setNoteAppearanceColors(
    note: SNNote,
    colors: { backgroundColor?: string | undefined; textColor?: string | undefined },
  ) {
    await this.application.mutator.changeItem<NoteMutator>(
      note,
      (mutator) => {
        if ('backgroundColor' in colors) {
          mutator.setAppDataItem(NoteCustomBackgroundColorKey, colors.backgroundColor)
        }
        if ('textColor' in colors) {
          mutator.setAppDataItem(NoteCustomTextColorKey, colors.textColor)
        }
      },
      MutationType.NoUpdateUserTimestamps,
    )
    this.application.sync.sync().catch(console.error)
  }

  async resetNoteAppearance(note: SNNote) {
    await this.setNoteAppearanceColors(note, { backgroundColor: undefined, textColor: undefined })
  }

  /**
   * Standard Red Notes: per-note hero header (cover banner). The config is
   * persisted in the note's encrypted appData (no models/server change) so the
   * cover syncs E2E with the note. The image is a bounded, pre-compressed JPEG
   * data URL — see HeroHeader/heroHeader.ts for the appData-bloat tradeoff. Writes
   * never bypass the note's locked state (callers must guard / we guard here).
   */
  private async writeNoteHeroHeader(note: SNNote, hero: HeroHeader | undefined) {
    if (note.locked) {
      return
    }
    await this.application.mutator.changeItem<NoteMutator>(
      note,
      (mutator) => {
        mutator.setAppDataItem(NoteHeroHeaderKey, hero)
      },
      MutationType.NoUpdateUserTimestamps,
    )
    this.application.sync.sync().catch(console.error)
  }

  /** Set (or replace) the note's cover image from an already-bounded data URL. */
  async setNoteHeroImage(note: SNNote, imageDataUrl: string) {
    const normalized = normalizeHeroImageDataUrl(imageDataUrl)
    if (!normalized) {
      return
    }
    const current = getNoteHeroHeader(note)
    await this.writeNoteHeroHeader(note, {
      imageDataUrl: normalized,
      height: current?.height ?? clampHeroHeight(undefined),
      focalY: current?.focalY ?? clampHeroFocalY(undefined),
    })
  }

  /** Adjust the cover banner height (no-op when there is no cover). */
  async setNoteHeroHeight(note: SNNote, height: number) {
    const current = getNoteHeroHeader(note)
    if (!current) {
      return
    }
    await this.writeNoteHeroHeader(note, { ...current, height: clampHeroHeight(height) })
  }

  /** Reposition the cover's vertical focal point, 0..1 (no-op without a cover). */
  async setNoteHeroFocalY(note: SNNote, focalY: number) {
    const current = getNoteHeroHeader(note)
    if (!current) {
      return
    }
    await this.writeNoteHeroHeader(note, { ...current, focalY: clampHeroFocalY(focalY) })
  }

  /** Remove the note's cover image (reverts to no-banner behavior). */
  async removeNoteHeroHeader(note: SNNote) {
    await this.writeNoteHeroHeader(note, undefined)
  }

  /**
   * Standard Red Notes: per-note reminders. Reminders are persisted in the
   * note's encrypted appData (no models/server change) so they sync E2E with the
   * note and survive across devices. All writes go through `setAppDataItem` and
   * use the pure helpers in `Reminders/reminders` to compute the next array.
   */
  private async writeNoteReminders(note: SNNote, reminders: Reminder[]) {
    await this.application.mutator.changeItem<NoteMutator>(
      note,
      (mutator) => {
        mutator.setAppDataItem(NoteRemindersKey, reminders.length > 0 ? reminders : undefined)
      },
      MutationType.NoUpdateUserTimestamps,
    )
    this.application.sync.sync().catch(console.error)
  }

  /** Add or replace a reminder on a note (matched by id). */
  async upsertNoteReminder(note: SNNote, reminder: Reminder) {
    const next = upsertReminderInList(getNoteReminders(note), reminder)
    await this.writeNoteReminders(note, next)
  }

  /** Remove a single reminder (by id) from a note. */
  async removeNoteReminder(note: SNNote, reminderId: string) {
    const next = removeReminderFromList(getNoteReminders(note), reminderId)
    await this.writeNoteReminders(note, next)
  }

  /** Clear all reminders from a note. */
  async clearNoteReminders(note: SNNote) {
    await this.writeNoteReminders(note, [])
  }

  /**
   * Standard Red Notes: per-note in-note bookmarks / markers (forum #3733).
   *
   * Persisted in the note's encrypted appData under the `bookmarks` key — the
   * EXACT mechanism used for `writeNoteReminders` above (and the hero header /
   * appearance helpers): `mutator.setAppDataItem` + `sync`. No models/server
   * change. Writing an empty list clears the key (mirrors writeNoteReminders).
   * Never bypasses a locked note.
   */
  private async writeNoteBookmarks(note: SNNote, bookmarks: Bookmark[]) {
    if (note.locked) {
      return
    }
    await this.application.mutator.changeItem<NoteMutator>(
      note,
      (mutator) => {
        mutator.setAppDataItem(NoteBookmarksKey, bookmarks.length > 0 ? bookmarks : undefined)
      },
      MutationType.NoUpdateUserTimestamps,
    )
    this.application.sync.sync().catch(console.error)
  }

  /** Add or replace a bookmark on a note (matched by id). */
  async upsertNoteBookmark(note: SNNote, bookmark: Bookmark) {
    const next = upsertBookmarkInList(getNoteBookmarks(note), bookmark)
    await this.writeNoteBookmarks(note, next)
  }

  /** Remove a single bookmark (by id) from a note. */
  async removeNoteBookmark(note: SNNote, bookmarkId: string) {
    const next = removeBookmarkFromList(getNoteBookmarks(note), bookmarkId)
    await this.writeNoteBookmarks(note, next)
  }

  /**
   * Patch a bookmark's editable fields (nickname/label, color, icon) by id — like
   * editing a tag. Passing `null` for color/icon clears it; `undefined` leaves it.
   */
  async updateNoteBookmark(
    note: SNNote,
    bookmarkId: string,
    patch: { label?: string; color?: string | null; icon?: string | null },
  ) {
    const next = updateBookmarkInList(getNoteBookmarks(note), bookmarkId, patch)
    await this.writeNoteBookmarks(note, next)
  }

  /** Mark a reminder (by id) as notified so the checker won't re-fire it. */
  async markNoteReminderNotified(note: SNNote, reminderId: string) {
    const next = markReminderNotifiedInList(getNoteReminders(note), reminderId)
    await this.writeNoteReminders(note, next)
  }

  /**
   * Standard Red Notes: after a reminder fires, settle its state.
   *
   *  - One-shot reminder: mark it `notified` (unchanged legacy behavior).
   *  - Recurring reminder: advance `dueAt` to the next future occurrence (looping
   *    forward past any intervals missed while offline) and clear `notified` so it
   *    re-arms. If "email me" is on, the next occurrence is re-registered with the
   *    server (best-effort) since the server-side email reminder is single-shot —
   *    we delete the previous server record and create a new one for the new time.
   *
   * Returns the resulting reminder (after advance) so callers can act on it; for a
   * one-shot it returns the input unchanged.
   */
  async settleFiredReminder(note: SNNote, reminderId: string, now: number): Promise<Reminder | undefined> {
    const current = getNoteReminders(note).find((reminder) => reminder.id === reminderId)
    if (!current) {
      return undefined
    }

    if (!isRecurring(current)) {
      await this.markNoteReminderNotified(note, reminderId)
      return current
    }

    const advanced = advanceRecurringReminder(current, now)

    // Re-register the next email occurrence (best-effort). The server email
    // reminder is single-shot, so on each advance we cancel the prior record and
    // create one for the new dueAt. Failures are swallowed: the in-app reminder
    // still advances; only the email for the next cycle may be missed.
    if (current.emailReminderId) {
      try {
        const { deleteEmailReminder, createEmailReminder } = await import('../../Reminders/emailReminders')
        await deleteEmailReminder(this.application, current.emailReminderId)
        const emailText = advanced.message?.trim() || 'Reminder'
        const newId = await createEmailReminder(this.application, advanced.dueAt, emailText)
        advanced.emailReminderId = newId ?? undefined
      } catch (error) {
        console.error(error)
        advanced.emailReminderId = undefined
      }
    }

    await this.upsertNoteReminder(note, advanced)
    return advanced
  }

  async addTagToSelectedNotes(tag: SNTag): Promise<void> {
    const selectedNotes = this.getSelectedNotesList()
    await Promise.all(
      selectedNotes.map(async (note) => {
        await this.application.mutator.addTagToNote(note, tag, this.shouldLinkToParentFolders)
      }),
    )
    this.application.sync.sync().catch(console.error)
  }

  async removeTagFromSelectedNotes(tag: SNTag): Promise<void> {
    const selectedNotes = this.getSelectedNotesList()
    await this.application.mutator.changeItem(tag, (mutator) => {
      for (const note of selectedNotes) {
        mutator.removeItemAsRelationship(note)
      }
    })
    this.application.sync.sync().catch(console.error)
  }

  isTagInSelectedNotes(tag: SNTag): boolean {
    const selectedNotes = this.getSelectedNotesList()
    return selectedNotes.every((note) =>
      this._getItemTags
        .execute(note)
        .getValue()
        .find((noteTag) => noteTag.uuid === tag.uuid),
    )
  }

  setShowProtectedWarning(show: boolean): void {
    this.showProtectedWarning = show
  }

  async emptyTrash(): Promise<void> {
    if (
      await confirmDialog({
        text: StringEmptyTrash(this.trashedNotesCount),
        confirmButtonStyle: 'danger',
      })
    ) {
      await this.application.mutator.emptyTrash()
      this.application.sync.sync().catch(console.error)
    }
  }

  private getSelectedNotesList(): SNNote[] {
    return Object.values(this.selectedNotes)
  }

  async createNoteWithContent(
    editorIdentifier: string,
    title: string,
    text: string,
    references: ContentReference[] = [],
  ): Promise<SNNote> {
    const noteType = noteTypeForEditorIdentifier(editorIdentifier)
    const selectedTag = this.application.navigationController.selected
    const templateNote = this.application.items.createTemplateItem<NoteContent, SNNote>(ContentType.TYPES.Note, {
      title,
      text,
      references,
      noteType,
      editorIdentifier,
    })
    const note = await this.application.mutator.insertItem<SNNote>(templateNote)
    if (selectedTag instanceof SNTag) {
      const shouldAddTagHierarchy = this.application.preferences.getValue(PrefKey.NoteAddToParentFolders, true)
      await this.application.mutator.addTagToNote(templateNote, selectedTag, shouldAddTagHierarchy)
    }
    return note
  }

  /**
   * Computes the parts a note would split into, without creating anything.
   * Useful for showing a live preview count in the split dialog.
   */
  previewSplitNote(note: SNNote, options: Omit<SplitNoteOptions, 'noteType'>): NotePart[] {
    return splitNoteContent(note.text ?? '', { ...options, noteType: note.noteType })
  }

  /**
   * Standard Red Notes: split a single note into multiple separate notes.
   *
   * The text is split via {@link splitNoteContent} (by headings, horizontal
   * rule, or a custom delimiter). Each part becomes a new PLAIN-text note
   * created through the real insert+tag path. For Super notes we split the
   * extracted plaintext (Lexical JSON can't be cleanly split here), so the
   * resulting parts are plain notes — the dialog warns the user about this.
   *
   * Options:
   *  - inheritTags: apply the original note's tags to each new part.
   *  - keepOriginal: keep the original as-is; when false the original is moved
   *    to TRASH (never hard-deleted).
   *  - linkParts: link each created part to the next (and to the original).
   *
   * Returns the created notes (empty if there was nothing to split on), and
   * selects/opens the first new note.
   */
  async splitNote(
    note: SNNote,
    options: Omit<SplitNoteOptions, 'noteType'> & {
      inheritTags: boolean
      keepOriginal: boolean
      linkParts: boolean
    },
  ): Promise<SNNote[]> {
    const parts = this.previewSplitNote(note, { mode: options.mode, delimiter: options.delimiter })

    if (parts.length < 2) {
      addToast({
        type: ToastType.Regular,
        message: 'There was nothing to split this note on.',
      })
      return []
    }

    const originalTags = options.inheritTags ? this.application.items.getSortedTagsForItem(note) : []
    const shouldLinkToParentFolders = this.application.preferences.getValue(PrefKey.NoteAddToParentFolders, true)

    const createdNotes: SNNote[] = []
    for (const part of parts) {
      const templateNote = this.application.items.createTemplateItem<NoteContent, SNNote>(ContentType.TYPES.Note, {
        title: part.title,
        text: part.content,
        references: [],
        noteType: NoteType.Plain,
        editorIdentifier: NativeFeatureIdentifier.TYPES.PlainEditor,
      })
      const createdNote = await this.application.mutator.insertItem<SNNote>(templateNote)

      for (const tag of originalTags) {
        await this.application.mutator.addTagToNote(createdNote, tag, shouldLinkToParentFolders)
      }

      createdNotes.push(createdNote)
    }

    if (options.linkParts) {
      // Link the original to the first part, then chain the parts together.
      try {
        if (options.keepOriginal && createdNotes[0]) {
          await this.application.mutator.linkNoteToNote(note, createdNotes[0])
        }
        for (let i = 0; i < createdNotes.length - 1; i++) {
          await this.application.mutator.linkNoteToNote(createdNotes[i], createdNotes[i + 1])
        }
      } catch (error) {
        console.error(error)
      }
    }

    if (!options.keepOriginal) {
      await this.application.mutator.changeItem<NoteMutator>(note, (mutator) => {
        mutator.trashed = true
      })
    }

    void this.application.sync.sync()

    const firstNote = createdNotes[0]
    if (firstNote) {
      this.application.itemListController.selectUuids([firstNote.uuid], true).catch(console.error)
    }

    addToast({
      type: ToastType.Success,
      message: `Split note into ${createdNotes.length} ${pluralize(createdNotes.length, 'note', 'notes')}.`,
    })

    return createdNotes
  }

  showSuperExportModal = () => {
    this.shouldShowSuperExportModal = true
  }
  closeSuperExportModal = () => {
    this.shouldShowSuperExportModal = false
  }

  // gets attribute info about the given notes in a single loop
  getNotesInfo = (notes: SNNote[]) => {
    let pinned = false,
      unpinned = false,
      starred = false,
      unstarred = false,
      trashed = false,
      notTrashed = false,
      archived = false,
      unarchived = false,
      hiddenPreviews = 0,
      unhiddenPreviews = 0,
      locked = 0,
      unlocked = 0,
      protecteds = 0,
      unprotected = 0,
      localOnlyCount = 0,
      syncedCount = 0

    for (let i = 0; i < notes.length; i++) {
      const note = notes[i]
      if (!note) {
        continue
      }
      if (note.pinned) {
        pinned = true
      } else {
        unpinned = true
      }
      if (note.starred) {
        starred = true
      } else {
        unstarred = true
      }
      if (note.trashed) {
        trashed = true
      } else {
        notTrashed = true
      }
      if (note.archived) {
        archived = true
      } else {
        unarchived = true
      }
      if (note.hidePreview) {
        hiddenPreviews++
      } else {
        unhiddenPreviews++
      }
      if (note.locked) {
        locked++
      } else {
        unlocked++
      }
      if (note.protected) {
        protecteds++
      } else {
        unprotected++
      }
      if (note.localOnly) {
        localOnlyCount++
      } else {
        syncedCount++
      }
    }

    return {
      pinned,
      unpinned,
      starred,
      unstarred,
      trashed,
      notTrashed,
      archived,
      unarchived,
      hidePreviews: hiddenPreviews > unhiddenPreviews,
      locked: locked > unlocked,
      protect: protecteds > unprotected,
      localOnly: localOnlyCount > syncedCount,
    }
  }

  downloadSelectedNotes = async () => {
    const notes = this.selectedNotes
    if (notes.length === 0) {
      return
    }
    const toast = addToast({
      type: ToastType.Progress,
      message: `Exporting ${notes.length} ${pluralize(notes.length, 'note', 'notes')}...`,
    })
    try {
      const result = await createNoteExport(this.application, notes)
      if (!result) {
        return
      }
      const { blob, fileName } = result
      void downloadOrShareBlobBasedOnPlatform({
        archiveService: this.application.archiveService,
        platform: this.application.platform,
        mobileDevice: this.application.mobileDevice,
        blob: blob,
        filename: fileName,
        isNativeMobileWeb: this.application.isNativeMobileWeb(),
      })
      dismissToast(toast)
    } catch (error) {
      console.error(error)
      addToast({
        type: ToastType.Error,
        message: 'Could not export notes',
      })
      dismissToast(toast)
    }
  }

  exportSelectedNotes = () => {
    const notes = this.selectedNotes
    const hasSuperNote = notes.some((note) => note.noteType === NoteType.Super)

    if (hasSuperNote) {
      this.showSuperExportModal()
      return
    }

    this.downloadSelectedNotes().catch(console.error)
  }

  duplicateSelectedNotes = async () => {
    const notes = this.selectedNotes
    await Promise.all(
      notes.map((note) =>
        this.application.mutator
          .duplicateItem(note)
          .then((duplicated) =>
            addToast({
              type: ToastType.Regular,
              message: `Duplicated note "${duplicated.title}"`,
              actions: [
                {
                  label: 'Open',
                  handler: (toastId: string) => {
                    this.application.itemListController.selectUuids([duplicated.uuid], true).catch(console.error)
                    dismissToast(toastId)
                  },
                },
              ],
              autoClose: true,
            }),
          )
          .catch(console.error),
      ),
    )
    void this.application.sync.sync()
  }

  /* ------------------------------------------------------------------------ */
  /* Templates (Standard Red Notes)                                           */
  /* ------------------------------------------------------------------------ */

  /** Whether a note is flagged as a reusable template. */
  noteIsTemplate(note: SNNote): boolean {
    return noteIsTemplate(note)
  }

  /**
   * Flag (or unflag) a note as a reusable template. The flag is stored in the
   * note's encrypted appData (mirrors the bookmark/reminder/appearance helpers):
   * `mutator.setAppDataItem` + `sync`. No models/server change. Writing `false`
   * clears the key. Never bypasses a locked note.
   */
  async setNoteIsTemplate(note: SNNote, isTemplate: boolean) {
    if (note.locked) {
      return
    }
    await this.application.mutator.changeItem<NoteMutator>(
      note,
      (mutator) => {
        mutator.setAppDataItem(NoteIsTemplateKey, isTemplate ? true : undefined)
      },
      MutationType.NoUpdateUserTimestamps,
    )
    this.application.sync.sync().catch(console.error)
  }

  /**
   * Create a brand new, INDEPENDENT note from a template note. The new note copies
   * the template's text + editor type (via `duplicateItem`, which preserves the
   * note's editorIdentifier/noteType and appData) but is explicitly NOT itself a
   * template (the template flag is cleared on the copy). The copy is opened.
   */
  async createNoteFromTemplate(template: SNNote): Promise<SNNote | undefined> {
    const duplicated = (await this.application.mutator.duplicateItem(template)) as SNNote
    if (!duplicated) {
      return undefined
    }
    // The copy must be a normal note, not another template.
    await this.setNoteIsTemplate(duplicated, false)
    await this.application.itemListController.selectUuids([duplicated.uuid], true)
    void this.application.sync.sync()
    return duplicated
  }
}

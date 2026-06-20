import { ContentType, SNNote, SNTag, FileItem, SessionListEntry } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { computePlaintextStats, extractPlaintextFromNoteText } from '@/Utils/NoteStats'

/**
 * A single recently-edited note, lightweight and serializable so the dashboard
 * (and the achievements feature) can render a list without holding item refs.
 */
export type RecentNote = {
  uuid: string
  title: string
  /** First line / preview of the note, truncated for display. */
  preview: string
  /** Epoch ms of the user-modified date (best "last edited" signal we have). */
  modified: number
}

/**
 * Derived, in-memory account statistics.
 *
 * Everything here is computed synchronously from already-synced items, EXCEPT
 * `lastLogin`, which is filled in from a one-shot sessions fetch (see
 * {@link deriveLastLoginFromSessions}). When sessions have not been fetched (or
 * the account is offline / signed out) `lastLogin` is `undefined`.
 */
export type AccountStatistics = {
  /** Non-trashed, non-archived notes. */
  noteCount: number
  /** Notes currently in the trash. */
  trashedCount: number
  /** Archived (non-trashed) notes. */
  archivedCount: number
  /** Pinned (non-trashed) notes. */
  pinnedCount: number
  /** Displayable tags. */
  tagCount: number
  /** Displayable files. */
  fileCount: number

  /**
   * Approximate total number of edits across the account.
   *
   * NOTE: the client does not have an authoritative per-note revision count in
   * memory (revisions are fetched lazily, per note, from the server). We instead
   * report the number of distinct notes that have been modified at least once
   * since creation — i.e. notes whose user-modified date is meaningfully after
   * their creation date. This is an HONEST lower-bound proxy for "edits", and is
   * labelled as "Notes edited" in the UI, not "total edits".
   */
  editedNoteCount: number

  /** Approximate total words across all non-trashed notes (plaintext extraction). */
  totalWords: number

  /** Epoch ms of the most recently modified item ("last change"), or undefined. */
  lastChange?: number
  /** Epoch ms of the oldest item's creation ("account age" anchor), or undefined. */
  firstItemCreated?: number
  /** Epoch ms of the last login, derived from a one-shot sessions fetch. */
  lastLogin?: number

  /** Most recently edited notes, newest first (capped). */
  recentNotes: RecentNote[]
}

export const DEFAULT_RECENT_NOTES_LIMIT = 6

/**
 * Cap how many notes we run plaintext extraction over for the word count. Beyond
 * this we stop counting words (the count is documented as approximate) so a huge
 * account never blocks the throttled recompute.
 */
const WORD_COUNT_NOTE_CAP = 2000

function noteModifiedMs(note: SNNote): number {
  return note.userModifiedDate?.getTime?.() ?? 0
}

function noteCreatedMs(note: SNNote): number {
  return note.created_at?.getTime?.() ?? 0
}

/**
 * Computes account statistics from the application's in-memory item state.
 *
 * Pure with respect to the passed application snapshot: it only reads items and
 * never triggers network activity. `lastLogin` is supplied separately (it comes
 * from the cached sessions fetch) so this function stays synchronous and cheap
 * enough to run on a throttle.
 *
 * Reusable: the achievements feature can import this directly to derive the same
 * numbers without duplicating the counting logic.
 */
export function computeAccountStatistics(
  application: WebApplication,
  options?: { recentNotesLimit?: number; lastLogin?: number },
): AccountStatistics {
  const recentNotesLimit = options?.recentNotesLimit ?? DEFAULT_RECENT_NOTES_LIMIT

  // All notes including trashed; we partition locally so counts are unambiguous.
  const allNotes = application.items.getItems<SNNote>(ContentType.TYPES.Note)
  const tags = application.items.getItems<SNTag>(ContentType.TYPES.Tag)
  const files = application.items.getItems<FileItem>(ContentType.TYPES.File)

  let noteCount = 0
  let trashedCount = 0
  let archivedCount = 0
  let pinnedCount = 0
  let editedNoteCount = 0
  let totalWords = 0
  let wordCountSampled = 0

  let lastChange: number | undefined
  let firstItemCreated: number | undefined

  const considerDates = (modified: number, created: number) => {
    if (modified > 0 && (lastChange === undefined || modified > lastChange)) {
      lastChange = modified
    }
    if (created > 0 && (firstItemCreated === undefined || created < firstItemCreated)) {
      firstItemCreated = created
    }
  }

  const nonTrashedNotes: SNNote[] = []

  for (const note of allNotes) {
    const modified = noteModifiedMs(note)
    const created = noteCreatedMs(note)
    considerDates(modified, created)

    if (note.trashed) {
      trashedCount++
      continue
    }

    nonTrashedNotes.push(note)

    if (note.archived) {
      archivedCount++
    } else {
      noteCount++
    }

    if (note.pinned) {
      pinnedCount++
    }

    // "Edited at least once": modified more than ~2s after creation. The 2s slop
    // avoids counting the initial save as an edit.
    if (modified - created > 2000) {
      editedNoteCount++
    }

    if (wordCountSampled < WORD_COUNT_NOTE_CAP) {
      wordCountSampled++
      const plaintext = extractPlaintextFromNoteText(note.text, note.noteType)
      totalWords += computePlaintextStats(plaintext).words
    }
  }

  // Tags and files also count toward "last change" / "account age".
  for (const tag of tags) {
    considerDates(tag.userModifiedDate?.getTime?.() ?? 0, tag.created_at?.getTime?.() ?? 0)
  }
  for (const file of files) {
    considerDates(file.userModifiedDate?.getTime?.() ?? 0, file.created_at?.getTime?.() ?? 0)
  }

  const recentNotes: RecentNote[] = nonTrashedNotes
    .slice()
    .sort((a, b) => noteModifiedMs(b) - noteModifiedMs(a))
    .slice(0, recentNotesLimit)
    .map((note) => ({
      uuid: note.uuid,
      title: note.title || 'Untitled',
      preview: (note.preview_plain || '').slice(0, 120),
      modified: noteModifiedMs(note),
    }))

  return {
    noteCount,
    trashedCount,
    archivedCount,
    pinnedCount,
    tagCount: tags.length,
    fileCount: files.length,
    editedNoteCount,
    totalWords,
    lastChange,
    firstItemCreated,
    lastLogin: options?.lastLogin,
    recentNotes,
  }
}

/**
 * Derives the "last login" epoch ms from a sessions list.
 *
 * Heuristic: the most recently CREATED session that is not the current one is
 * the previous login. When the only session is the current one (fresh account,
 * or all other sessions revoked) we fall back to the current session's creation
 * date, which is itself a login event.
 */
export function deriveLastLoginFromSessions(sessions: SessionListEntry[]): number | undefined {
  if (sessions.length === 0) {
    return undefined
  }

  const parse = (value: string): number => {
    const ms = new Date(value).getTime()
    return Number.isNaN(ms) ? 0 : ms
  }

  const nonCurrent = sessions.filter((session) => !session.current)
  const pool = nonCurrent.length > 0 ? nonCurrent : sessions

  let latest = 0
  for (const session of pool) {
    const created = parse(session.created_at)
    if (created > latest) {
      latest = created
    }
  }

  return latest > 0 ? latest : undefined
}

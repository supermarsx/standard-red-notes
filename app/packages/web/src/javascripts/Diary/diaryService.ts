import { WebApplication } from '@/Application/WebApplication'
import { ContentType, NoteContent, SNNote } from '@standardnotes/snjs'
import {
  DiarySettings,
  dateKeyForDate,
  diaryTitleForDate,
  normalizeDiarySettings,
} from './diary'

/**
 * Standard Red Notes: Diary mode — application-bound side effects.
 *
 * This module is the impure counterpart to `diary.ts`: it reads/writes the
 * Diary settings and the per-day dedupe marker, finds/creates the dated diary
 * note inside a dedicated "Diary" tag, and opens it.
 *
 * Storage choices (web-only, no `@standardnotes/models` changes):
 *  - Settings (enable flag + prompt time) live in the app storage K/V via
 *    `application.getValue`/`setValue` under {@link DiarySettingsKey} — the same
 *    local-store precedent used by email-backup/large-file, which avoided adding
 *    keys to the published `PrefKey` enum.
 *  - The "last prompted date" dedupe marker lives in `window.localStorage` under
 *    {@link DiaryLastPromptedKey} (per-device, not synced) so the once-a-day
 *    prompt fires at most once per calendar day on this device.
 */

export const DiarySettingsKey = 'DiaryMode'
export const DiaryLastPromptedKey = 'DiaryMode.lastPromptedDate'

/** The tag every diary entry is filed under. */
export const DiaryTagTitle = 'Diary'

/** Read the persisted Diary settings (normalized, never throws). */
export function getDiarySettings(application: WebApplication): DiarySettings {
  const raw = application.getValue<Partial<DiarySettings> | undefined>(DiarySettingsKey)
  return normalizeDiarySettings(raw)
}

/** Persist the Diary settings. */
export function setDiarySettings(application: WebApplication, settings: DiarySettings): void {
  application.setValue(DiarySettingsKey, normalizeDiarySettings(settings))
}

/** Read the dedupe marker (the date key we last prompted on), or null. */
export function getLastPromptedDateKey(): string | null {
  try {
    return window.localStorage.getItem(DiaryLastPromptedKey)
  } catch {
    return null
  }
}

/** Record that we prompted for `dateKey` so we don't prompt again that day. */
export function setLastPromptedDateKey(dateKey: string): void {
  try {
    window.localStorage.setItem(DiaryLastPromptedKey, dateKey)
  } catch {
    // Storage may be unavailable (private mode quota); the in-session guard in
    // the scheduler still prevents a double-fire within this session.
  }
}

/** Find the existing diary note for `date` by its deterministic dated title. */
export function findDiaryNoteForDate(application: WebApplication, date: Date): SNNote | undefined {
  const title = diaryTitleForDate(date)
  const notes = application.items.getItems<SNNote>(ContentType.TYPES.Note)
  return notes.find((note) => !note.trashed && note.title === title)
}

/** True if a (non-trashed) diary entry already exists for `date`. */
export function diaryEntryExistsForDate(application: WebApplication, date: Date): boolean {
  return findDiaryNoteForDate(application, date) !== undefined
}

/**
 * Create or open the diary entry for `date` (defaults to today), then open it in
 * the editor. If the dated note already exists it is reused; otherwise a new note
 * titled with the date is created, filed under the "Diary" tag, and opened.
 *
 * Returns the note (or undefined if creation failed). Safe to call any time
 * (used by both the notification click handler and the command-palette command).
 */
export async function openOrCreateDiaryEntry(
  application: WebApplication,
  date: Date = new Date(),
): Promise<SNNote | undefined> {
  const existing = findDiaryNoteForDate(application, date)
  if (existing) {
    await application.itemListController.openNote(existing.uuid)
    return existing
  }

  const title = diaryTitleForDate(date)
  const template = application.items.createTemplateItem<NoteContent, SNNote>(ContentType.TYPES.Note, {
    title,
    text: '',
    references: [],
  })
  const note = await application.mutator.insertItem<SNNote>(template)

  try {
    const tag = await application.mutator.findOrCreateTag(DiaryTagTitle)
    await application.mutator.addTagToNote(note, tag, false)
  } catch (error) {
    // Filing under the Diary tag is best-effort; the dated note still exists and
    // opens even if tagging fails.
    console.error('Diary: failed to file entry under Diary tag', error)
  }

  await application.sync.sync().catch(console.error)
  await application.itemListController.openNote(note.uuid)
  return note
}

export { dateKeyForDate }

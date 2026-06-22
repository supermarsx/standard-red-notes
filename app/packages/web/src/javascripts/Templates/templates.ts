import { AppDataField, SNNote } from '@standardnotes/snjs'

/**
 * Standard Red Notes: reusable note templates.
 *
 * A note can be flagged as a "template" so it shows up in a dedicated Templates
 * view, from which the user can spin up a fresh, independent note that copies the
 * template's text + editor type (but is NOT itself a template).
 *
 * ## Where the flag is stored (and why)
 * The flag lives in the note's encrypted `appData` bag under a single boolean
 * key — the EXACT mechanism used for `bookmarks`, `reminders`, `heroHeader`, and
 * the per-note appearance colors. We persist via `setAppDataItem` and read via
 * `getAppDomainValue`.
 *
 * Preferred over a dedicated tag/SmartView because:
 *  - It syncs end-to-end with the note (the flag set on one device shows on all).
 *  - It is tied to the note's lifecycle (delete the note, the flag goes too).
 *  - It needs ZERO models/server changes: the key is not in the published
 *    `AppDataField` enum (which lives in the models package we must not touch),
 *    so we cast our string key to `AppDataField` at the storage boundary, exactly
 *    like the bookmark/reminder/hero/appearance helpers do — `setAppDataItem` /
 *    `getAppDomainValue` accept any string key.
 *  - A tag would clutter the user's tag list and could be removed/renamed by the
 *    user; an internal appData flag is invisible plumbing, matching the existing
 *    fork conventions for note metadata.
 */
export const NoteIsTemplateKey = 'isTemplate' as unknown as AppDataField

/** True when the note is flagged as a reusable template. */
export function noteIsTemplate(note: SNNote): boolean {
  return note.getAppDomainValue<unknown>(NoteIsTemplateKey) === true
}

/** A template note paired with a short preview for the Templates list. */
export type TemplateEntry = {
  note: SNNote
  title: string
  preview: string
}

/** Trim a note's text into a short single-line preview for the list. */
function previewForNote(note: SNNote): string {
  const text = (note.preview_plain || note.text || '').replace(/\s+/g, ' ').trim()
  return text.length > 140 ? `${text.slice(0, 140)}…` : text
}

/**
 * Collect every template note from the given notes, sorted by title. Pure /
 * in-memory — derived from local item state, no server polling (mirrors the
 * Bookmarks aggregate view).
 */
export function collectTemplates(notes: SNNote[]): TemplateEntry[] {
  const result: TemplateEntry[] = []
  for (const note of notes) {
    if (note.trashed || note.archived) {
      continue
    }
    if (noteIsTemplate(note)) {
      const title = note.title?.trim() || 'Untitled'
      result.push({ note, title, preview: previewForNote(note) })
    }
  }
  return result.sort((a, b) => a.title.localeCompare(b.title))
}

/** Narrow a template list by a free-text query (title + preview). */
export function filterTemplates(templates: TemplateEntry[], query: string): TemplateEntry[] {
  const trimmed = query.trim().toLowerCase()
  if (trimmed.length === 0) {
    return templates
  }
  return templates.filter(
    (entry) =>
      entry.title.toLowerCase().includes(trimmed) || entry.preview.toLowerCase().includes(trimmed),
  )
}

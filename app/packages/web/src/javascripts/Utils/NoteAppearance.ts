import { AppDataField, SNNote } from '@standardnotes/snjs'

/**
 * Standard Red Notes: per-note custom appearance (background + text color).
 *
 * These values are stored in the note's encrypted `appData` bag (the same
 * mechanism used for `pinned`, `archived`, `locked`, etc.) so they sync E2E
 * with the note and require ZERO models/server changes. We persist them under
 * the default app domain using `setAppDataItem`/`getAppDomainValue`.
 *
 * The keys are not part of the `AppDataField` enum (which lives in the models
 * package we must not modify), so we cast our string keys to `AppDataField` at
 * the call sites. `setAppDataItem`/`getAppDomainValue` accept any string key.
 *
 * "Follow theme" (the default) is represented by the absence of a value
 * (`undefined`). Clearing an override stores `undefined`, which makes the note
 * render with no inline color so the active theme fully controls appearance.
 */

export const NoteCustomBackgroundColorKey = 'customBackgroundColor' as unknown as AppDataField
export const NoteCustomTextColorKey = 'customTextColor' as unknown as AppDataField

export type NoteAppearanceColors = {
  backgroundColor: string | undefined
  textColor: string | undefined
}

export function getNoteCustomBackgroundColor(note: SNNote): string | undefined {
  return note.getAppDomainValue<string | undefined>(NoteCustomBackgroundColorKey)
}

export function getNoteCustomTextColor(note: SNNote): string | undefined {
  return note.getAppDomainValue<string | undefined>(NoteCustomTextColorKey)
}

export function getNoteAppearanceColors(note: SNNote): NoteAppearanceColors {
  return {
    backgroundColor: getNoteCustomBackgroundColor(note),
    textColor: getNoteCustomTextColor(note),
  }
}

export function noteHasCustomAppearance(note: SNNote): boolean {
  return getNoteCustomBackgroundColor(note) != undefined || getNoteCustomTextColor(note) != undefined
}

/**
 * Curated presets that read reasonably against both light and dark themes.
 * Each pairs a background with a complementary text color.
 */
export const NoteAppearancePresets: { name: string; backgroundColor: string; textColor: string }[] = [
  { name: 'Sunshine', backgroundColor: '#fff8c4', textColor: '#403a00' },
  { name: 'Mint', backgroundColor: '#dcfce7', textColor: '#0f3d24' },
  { name: 'Sky', backgroundColor: '#dbeafe', textColor: '#0b2a4a' },
  { name: 'Rose', backgroundColor: '#ffe4e6', textColor: '#4a1020' },
  { name: 'Lavender', backgroundColor: '#ede9fe', textColor: '#2e1065' },
  { name: 'Slate', backgroundColor: '#1f2933', textColor: '#e6edf3' },
]

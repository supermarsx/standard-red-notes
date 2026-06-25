/**
 * Standard Red Notes: per-note document "Layout" settings for the Super editor.
 *
 * These drive the page layout used when PRINTING / EXPORTING a note: page size,
 * orientation, margins, and the number of text columns the note content flows
 * into. They are web-local (unsynced) and stored in localStorage under a single
 * versioned key as a `{ [noteUuid]: NoteLayout }` map, mirroring the other
 * `*Settings.ts` modules. snjs models are intentionally left untouched.
 *
 * Never throws — malformed storage falls back to the defaults.
 */

/** A selectable page-size option. `cssSize` is the CSS `@page size` keyword/dimensions. */
export type PageSizeOption = {
  /** Stable id persisted per note. */
  id: string
  /** Human-readable label shown in the dropdown. */
  label: string
  /**
   * The portrait-orientation CSS dimensions for `@page { size: <cssSize> }`.
   * For named sizes CSS understands (A3/A4/A5/Letter/Legal) we emit the keyword;
   * for sizes without a CSS keyword we emit explicit dimensions. Orientation is
   * appended separately (e.g. `A4 landscape`).
   */
  cssSize: string
}

/**
 * ISO A-series + US page sizes. CSS `@page` understands the A-series and the
 * common US keywords (`letter`, `legal`), so we use the keyword where possible;
 * `tabloid` is not a CSS keyword, so we give explicit inches.
 */
export const PAGE_SIZE_OPTIONS: PageSizeOption[] = [
  { id: 'a3', label: 'A3', cssSize: 'A3' },
  { id: 'a4', label: 'A4', cssSize: 'A4' },
  { id: 'a5', label: 'A5', cssSize: 'A5' },
  { id: 'a6', label: 'A6', cssSize: 'A6' },
  { id: 'letter', label: 'Letter', cssSize: 'letter' },
  { id: 'legal', label: 'Legal', cssSize: 'legal' },
  { id: 'tabloid', label: 'Tabloid', cssSize: '11in 17in' },
]

export const DEFAULT_PAGE_SIZE_ID = 'a4'

export type PageOrientation = 'portrait' | 'landscape'

/** Built-in margin presets (the value is a CSS length applied to all four sides). */
export type MarginPreset = {
  id: string
  label: string
  /** CSS length used for `@page { margin: <value> }`. */
  value: string
}

export const MARGIN_PRESETS: MarginPreset[] = [
  { id: 'normal', label: 'Normal', value: '1.5cm' },
  { id: 'narrow', label: 'Narrow', value: '0.5cm' },
  { id: 'wide', label: 'Wide', value: '2.5cm' },
  { id: 'none', label: 'None', value: '0' },
]

export const DEFAULT_MARGIN_ID = 'normal'

/** Sentinel id used when the user typed their own margin value. */
export const CUSTOM_MARGIN_ID = 'custom'

export const MIN_COLUMNS = 1
export const MAX_COLUMNS = 6

export type NoteLayout = {
  /** Id from PAGE_SIZE_OPTIONS. */
  pageSizeId: string
  orientation: PageOrientation
  /** Id from MARGIN_PRESETS, or CUSTOM_MARGIN_ID when `customMargin` is used. */
  marginId: string
  /** Free-text CSS length used when `marginId === CUSTOM_MARGIN_ID`. */
  customMargin: string
  /** Number of text columns the note content flows into (1 == single column). */
  columns: number
}

export const DEFAULT_NOTE_LAYOUT: NoteLayout = {
  pageSizeId: DEFAULT_PAGE_SIZE_ID,
  orientation: 'portrait',
  marginId: DEFAULT_MARGIN_ID,
  customMargin: '1cm',
  columns: 1,
}

const STORAGE_KEY = 'standardnotes.note.layout.v1'

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) {
    return fallback
  }
  return Math.min(max, Math.max(min, Math.round(n)))
}

const asString = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback)

/** Coerce an arbitrary persisted value into a safe NoteLayout. Never throws. */
export function normalizeNoteLayout(raw: unknown): NoteLayout {
  if (!raw || typeof raw !== 'object') {
    return DEFAULT_NOTE_LAYOUT
  }
  const candidate = raw as Partial<NoteLayout>

  const pageSizeId = PAGE_SIZE_OPTIONS.some((option) => option.id === candidate.pageSizeId)
    ? (candidate.pageSizeId as string)
    : DEFAULT_NOTE_LAYOUT.pageSizeId

  const orientation: PageOrientation = candidate.orientation === 'landscape' ? 'landscape' : 'portrait'

  const isKnownMargin =
    candidate.marginId === CUSTOM_MARGIN_ID || MARGIN_PRESETS.some((preset) => preset.id === candidate.marginId)
  const marginId = isKnownMargin ? (candidate.marginId as string) : DEFAULT_NOTE_LAYOUT.marginId

  return {
    pageSizeId,
    orientation,
    marginId,
    customMargin: asString(candidate.customMargin, DEFAULT_NOTE_LAYOUT.customMargin),
    columns: clampInt(candidate.columns, MIN_COLUMNS, MAX_COLUMNS, DEFAULT_NOTE_LAYOUT.columns),
  }
}

type LayoutMap = Record<string, NoteLayout>

function loadAllLayouts(): LayoutMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return {}
    }
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') {
      return {}
    }
    const result: LayoutMap = {}
    for (const [uuid, value] of Object.entries(parsed as Record<string, unknown>)) {
      result[uuid] = normalizeNoteLayout(value)
    }
    return result
  } catch {
    return {}
  }
}

/** Load a single note's layout (defaults when absent / unparseable). */
export function loadNoteLayout(noteUuid: string | undefined): NoteLayout {
  if (!noteUuid) {
    return DEFAULT_NOTE_LAYOUT
  }
  const all = loadAllLayouts()
  return all[noteUuid] ? normalizeNoteLayout(all[noteUuid]) : DEFAULT_NOTE_LAYOUT
}

/** Persist a single note's layout, merging into the shared map. */
export function saveNoteLayout(noteUuid: string | undefined, layout: NoteLayout): void {
  if (!noteUuid) {
    return
  }
  try {
    const all = loadAllLayouts()
    all[noteUuid] = normalizeNoteLayout(layout)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
  } catch {
    /* ignore quota / disabled storage */
  }
}

/** Resolve the CSS the print/export layout needs from a NoteLayout. */
export function resolvePageSize(layout: NoteLayout): PageSizeOption {
  return PAGE_SIZE_OPTIONS.find((option) => option.id === layout.pageSizeId) ?? PAGE_SIZE_OPTIONS[1]
}

/** The CSS length applied as the page margin (preset value or custom text). */
export function resolveMargin(layout: NoteLayout): string {
  if (layout.marginId === CUSTOM_MARGIN_ID) {
    const trimmed = layout.customMargin.trim()
    return trimmed.length > 0 ? trimmed : DEFAULT_NOTE_LAYOUT.customMargin
  }
  const preset = MARGIN_PRESETS.find((item) => item.id === layout.marginId)
  return preset ? preset.value : '1.5cm'
}

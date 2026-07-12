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

/** Highest start-at page number we accept (guards against absurd persisted values). */
export const MAX_PAGE_START = 100000

/** How a page number is rendered in the paginated (docx/odt/pdf) output. */
export type PageNumberFormat = 'n' | 'n-of-total' | 'page-n' // "1" | "1 / 8" | "Page 1"
/** Horizontal placement of header/footer/page-number content. */
export type HeaderFooterAlign = 'left' | 'center' | 'right'

/**
 * Portable font-family choice for header/footer text. Deliberately a tiny generic
 * whitelist (not arbitrary names) so every output format — docx, ODF, and the
 * react-pdf standard-14 set (no font registration) — maps it to a concrete font
 * that renders predictably. `default` means "no font override" (format default).
 */
export type HeaderFooterFontId = 'default' | 'serif' | 'sans' | 'mono'
export const HEADER_FOOTER_FONTS: { id: HeaderFooterFontId; label: string }[] = [
  { id: 'default', label: 'Default' },
  { id: 'serif', label: 'Serif' },
  { id: 'sans', label: 'Sans-serif' },
  { id: 'mono', label: 'Monospace' },
]
export const HEADER_FOOTER_FONT_IDS: HeaderFooterFontId[] = HEADER_FOOTER_FONTS.map((f) => f.id)

/** Inclusive bounds for a header/footer font size (points). */
export const MIN_HF_FONT_PT = 6
export const MAX_HF_FONT_PT = 72

/** Page numbering config carried in the paginated output (default OFF). */
export type PageNumbering = {
  enabled: boolean
  format: PageNumberFormat
  align: HeaderFooterAlign
  /** Where the number sits — in the running header or footer. */
  location: 'header' | 'footer'
  /** First page's displayed number (clamped >= 1). */
  startAt: number
}

/**
 * A running header/footer line (default OFF). `text` is free text that may embed
 * the `{page}` / `{total}` tokens, substituted with the live page-number /
 * page-count field by each generator (docx field, ODF `<text:page-number>`,
 * PDF `render`). Without a token it is static text.
 */
export type HeaderFooter = {
  enabled: boolean
  text: string
  align: HeaderFooterAlign
  /**
   * Optional per-band text style. ALL optional and absent by default — a legacy
   * record or the default carries NONE of these keys, so it maps to the minimal
   * options shape and exports byte-identically. Each generator omits its output
   * for an absent field (⇒ format default).
   */
  fontId?: HeaderFooterFontId
  /** Font size in points, clamped to MIN_HF_FONT_PT..MAX_HF_FONT_PT. */
  fontSizePt?: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  /** Validated lowercase `#rrggbb`; any invalid value is dropped, never emitted. */
  color?: string
}

/**
 * On-screen navigation sidebar (Word-style document outline) settings.
 *
 * This is a PURELY ON-SCREEN affordance — it drives a live outline of the note's
 * headings + bookmarks rendered beside the editor content, and has NOTHING to do
 * with print/export. It lives on `NoteLayout` only because that is the note's
 * per-note web-local settings bag the Layout popover already owns; the export
 * mapper (`noteLayoutToPageLayoutOptions`) deliberately IGNORES it so exported
 * docx/odt/pdf output stays byte-identical whether the sidebar is on or off.
 */
export type NavigationSettings = {
  /** Whether the outline sidebar is shown beside the editor (default OFF). */
  visible: boolean
  /** Whether the sidebar also lists the note's bookmarks (default ON). */
  showBookmarks: boolean
}

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
  /**
   * Page numbering / header / footer for the paginated exports (docx/odt/pdf).
   * ALL default OFF, so an un-opted-in note exports byte-identically to before —
   * `normalizeNoteLayout` back-fills these onto legacy records (no migration).
   * Browser print cannot honor them (CSS `@page` margin boxes are unsupported);
   * see applyPrintLayout.ts.
   */
  pageNumbering: PageNumbering
  header: HeaderFooter
  footer: HeaderFooter
  /**
   * On-screen navigation sidebar (outline of headings + bookmarks). Defaults to
   * hidden. This is NOT an export band — the export mapper ignores it entirely.
   * `normalizeNoteLayout` back-fills it onto legacy records (no migration).
   */
  navigation: NavigationSettings
}

export const DEFAULT_NOTE_LAYOUT: NoteLayout = {
  pageSizeId: DEFAULT_PAGE_SIZE_ID,
  orientation: 'portrait',
  marginId: DEFAULT_MARGIN_ID,
  customMargin: '1cm',
  columns: 1,
  pageNumbering: { enabled: false, format: 'page-n', align: 'center', location: 'footer', startAt: 1 },
  header: { enabled: false, text: '', align: 'center' },
  footer: { enabled: false, text: '', align: 'center' },
  navigation: { visible: false, showBookmarks: true },
}

export const PAGE_NUMBER_FORMATS: PageNumberFormat[] = ['n', 'n-of-total', 'page-n']
export const HEADER_FOOTER_ALIGNS: HeaderFooterAlign[] = ['left', 'center', 'right']

const STORAGE_KEY = 'standardnotes.note.layout.v1'

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) {
    return fallback
  }
  return Math.min(max, Math.max(min, Math.round(n)))
}

const asString = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback)

const asEnum = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback

/** Coerce a persisted value into a safe PageNumbering. Never throws. */
function normalizePageNumbering(raw: unknown): PageNumbering {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Partial<PageNumbering>
  return {
    enabled: c.enabled === true,
    format: asEnum(c.format, PAGE_NUMBER_FORMATS, DEFAULT_NOTE_LAYOUT.pageNumbering.format),
    align: asEnum(c.align, HEADER_FOOTER_ALIGNS, DEFAULT_NOTE_LAYOUT.pageNumbering.align),
    location: c.location === 'header' ? 'header' : 'footer',
    startAt: clampInt(c.startAt, 1, MAX_PAGE_START, DEFAULT_NOTE_LAYOUT.pageNumbering.startAt),
  }
}

/** Clamp a persisted header/footer font size into range, or omit when not a finite number. */
const normalizeHfFontSize = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  return Math.min(MAX_HF_FONT_PT, Math.max(MIN_HF_FONT_PT, Math.round(value)))
}

/** Validate + normalize a hex color to lowercase `#rrggbb`, or omit when invalid. */
const normalizeHexColor = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined
  }
  const match = value.trim().match(/^#?([0-9a-fA-F]{6})$/)
  return match ? `#${match[1].toLowerCase()}` : undefined
}

/**
 * Coerce a persisted value into a safe HeaderFooter. Never throws.
 *
 * The optional style fields are set ONLY when validly present, so a legacy record
 * (and the default) keeps the minimal `{ enabled, text, align }` shape — that is
 * what keeps the mapper/export byte-identical with no migration. A `fontId` of
 * `default` is treated as "no font" and dropped for the same reason.
 */
function normalizeHeaderFooter(raw: unknown, fallback: HeaderFooter): HeaderFooter {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Partial<HeaderFooter>
  const hf: HeaderFooter = {
    enabled: c.enabled === true,
    text: asString(c.text, fallback.text),
    align: asEnum(c.align, HEADER_FOOTER_ALIGNS, fallback.align),
  }
  if (
    typeof c.fontId === 'string' &&
    (HEADER_FOOTER_FONT_IDS as readonly string[]).includes(c.fontId) &&
    c.fontId !== 'default'
  ) {
    hf.fontId = c.fontId as HeaderFooterFontId
  }
  const fontSizePt = normalizeHfFontSize(c.fontSizePt)
  if (fontSizePt != null) {
    hf.fontSizePt = fontSizePt
  }
  if (c.bold === true) {
    hf.bold = true
  }
  if (c.italic === true) {
    hf.italic = true
  }
  if (c.underline === true) {
    hf.underline = true
  }
  const color = normalizeHexColor(c.color)
  if (color) {
    hf.color = color
  }
  return hf
}

/**
 * Coerce a persisted value into a safe NavigationSettings. Never throws.
 * `visible` defaults OFF (only strict `true` shows it); `showBookmarks` defaults
 * ON (only strict `false` disables it) so a legacy record without the field still
 * lists bookmarks once the sidebar is turned on.
 */
function normalizeNavigation(raw: unknown): NavigationSettings {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Partial<NavigationSettings>
  return {
    visible: c.visible === true,
    showBookmarks: c.showBookmarks !== false,
  }
}

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
    pageNumbering: normalizePageNumbering(candidate.pageNumbering),
    header: normalizeHeaderFooter(candidate.header, DEFAULT_NOTE_LAYOUT.header),
    footer: normalizeHeaderFooter(candidate.footer, DEFAULT_NOTE_LAYOUT.footer),
    navigation: normalizeNavigation(candidate.navigation),
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

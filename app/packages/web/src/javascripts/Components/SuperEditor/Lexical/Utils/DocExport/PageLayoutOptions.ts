/**
 * Standard Red Notes: the SERIALIZABLE page-layout options threaded into the
 * paginated generators (docx / odt / pdf). It is deliberately a plain data shape
 * (no functions) so it can cross the PDF comlink worker boundary, and it is
 * decoupled from the UI/localStorage `NoteLayout` — the only coupling is the
 * pure `noteLayoutToPageLayoutOptions` mapper below (types are import-erased).
 *
 * `undefined` (or an all-absent object) means: no headers, no footers, no page
 * numbering — i.e. the generators emit exactly their pre-t48 baseline output.
 */
import type {
  HeaderFooterAlign,
  HeaderFooterFontId,
  NoteLayout,
  PageNumberFormat,
} from '../../../Layout/layoutSettings'

/** Tokens a header/footer `text` may embed; substituted with live fields per generator. */
export const PAGE_TOKEN = '{page}'
export const TOTAL_TOKEN = '{total}'

/**
 * Optional per-band text style carried into the generators. Every field is
 * optional; an absent field ⇒ the generator omits its output for it ⇒ format
 * default (so an un-styled band exports byte-identically to the pre-t59 baseline).
 * `color` is a validated `#rrggbb`; `fontId` is never `'default'` here (dropped by
 * the mapper) so its presence always means a real font override.
 */
export type HeaderFooterStyle = {
  fontId?: HeaderFooterFontId
  fontSizePt?: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  color?: string
}

export type PageLayoutOptions = {
  pageNumber?: {
    format: PageNumberFormat
    align: HeaderFooterAlign
    location: 'header' | 'footer'
    startAt: number
  }
  header?: { text: string; align: HeaderFooterAlign } & HeaderFooterStyle
  footer?: { text: string; align: HeaderFooterAlign } & HeaderFooterStyle
}

/** Concrete per-format font names for a portable HeaderFooterFontId. */
export type ResolvedFont = { docx?: string; odf?: string; pdf?: string }

/**
 * Single source of truth mapping a portable font id to concrete per-format font
 * names. The whitelist is generic (4 choices) so all three outputs — including
 * the react-pdf standard-14 set (which needs NO font registration) — render
 * predictably. An unknown / `default` id resolves to `{}` (every field omitted ⇒
 * each format inherits its own default face).
 */
export const resolveFont = (fontId?: HeaderFooterFontId): ResolvedFont => {
  switch (fontId) {
    case 'serif':
      return { docx: 'Times New Roman', odf: 'Times New Roman', pdf: 'Times-Roman' }
    case 'sans':
      return { docx: 'Arial', odf: 'Arial', pdf: 'Helvetica' }
    case 'mono':
      return { docx: 'Courier New', odf: 'Courier New', pdf: 'Courier' }
    default:
      return {}
  }
}

/** Copy only the defined style fields off a band (dropping the no-op `default` font). */
const pickStyle = (band: HeaderFooterStyle): HeaderFooterStyle => {
  const style: HeaderFooterStyle = {}
  if (band.fontId && band.fontId !== 'default') {
    style.fontId = band.fontId
  }
  if (band.fontSizePt != null) {
    style.fontSizePt = band.fontSizePt
  }
  if (band.bold) {
    style.bold = true
  }
  if (band.italic) {
    style.italic = true
  }
  if (band.underline) {
    style.underline = true
  }
  if (band.color) {
    style.color = band.color
  }
  return style
}

/**
 * Pure mapper: NoteLayout → PageLayoutOptions. Returns `undefined` when nothing
 * is enabled so callers pass no options and the generators stay on their
 * baseline (back-compat) path.
 */
export const noteLayoutToPageLayoutOptions = (layout: NoteLayout): PageLayoutOptions | undefined => {
  const options: PageLayoutOptions = {}
  if (layout.pageNumbering.enabled) {
    options.pageNumber = {
      format: layout.pageNumbering.format,
      align: layout.pageNumbering.align,
      location: layout.pageNumbering.location,
      startAt: layout.pageNumbering.startAt,
    }
  }
  if (layout.header.enabled) {
    options.header = { text: layout.header.text, align: layout.header.align, ...pickStyle(layout.header) }
  }
  if (layout.footer.enabled) {
    options.footer = { text: layout.footer.text, align: layout.footer.align, ...pickStyle(layout.footer) }
  }
  return options.pageNumber || options.header || options.footer ? options : undefined
}

/** True when at least one band (text or page-number) occupies the given location. */
export const hasBandAt = (options: PageLayoutOptions, location: 'header' | 'footer'): boolean => {
  const section = location === 'header' ? options.header : options.footer
  const pageNumberHere = options.pageNumber != null && options.pageNumber.location === location
  return section != null || pageNumberHere
}

/** The page-number offset a `startAt` implies (page 1 shows `startAt`). */
export const pageStartOffset = (options: PageLayoutOptions): number => {
  return options.pageNumber ? options.pageNumber.startAt - 1 : 0
}

/**
 * Standard Red Notes: the SERIALIZABLE page-layout options threaded into the
 * paginated generators (docx / odt / pdf). It is deliberately a plain data shape
 * (no functions) so it can cross the PDF comlink worker boundary, and it is
 * decoupled from the UI/localStorage `NoteLayout` — the only coupling is the
 * pure `noteLayoutToPageLayoutOptions` mapper below.
 *
 * `undefined` (or an all-absent object) means: no headers, no footers, no page
 * numbering — i.e. the generators emit exactly their pre-t48 baseline output.
 */
import {
  type HeaderFooterAlign,
  type HeaderFooterFontId,
  type NoteLayout,
  type PageNumberFormat,
  resolveMargin,
  resolvePageDimensionsMm,
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
  /** Concrete, orientation-resolved physical page geometry. */
  geometry?: { widthMm: number; heightMm: number; marginMm: number; columns: number }
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
 * Pure mapper: NoteLayout → PageLayoutOptions. Paginated note exports opt into
 * physical geometry. Existing band-only callers retain their absent-options
 * baseline when no bands are enabled.
 */
export const noteLayoutToPageLayoutOptions = (
  layout: NoteLayout,
  includeGeometry = false,
): PageLayoutOptions | undefined => {
  const options: PageLayoutOptions = {}
  if (includeGeometry) {
    options.geometry = validatedPageGeometry({
      ...resolvePageDimensionsMm(layout),
      marginMm: marginLengthToMm(resolveMargin(layout)),
      columns: layout.columns,
    })
  }
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
  return options.geometry || options.pageNumber || options.header || options.footer ? options : undefined
}

export const millimetersToPoints = (value: number): number => (value * 72) / 25.4

/** Physical exports cannot resolve relative CSS lengths or margin shorthands. */
export const marginLengthToMm = (value: string): number => {
  const match = /^(\d+(?:\.\d+)?|\.\d+)\s*(mm|cm|in|pt|pc|px)?$/i.exec(value.trim())
  const factors: Record<string, number> = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96 }
  if (!match || (!match[2] && Number(match[1]) !== 0)) {
    throw new Error(
      'Document exports require one page margin in mm, cm, in, pt, pc or px. Update the Page margin setting.',
    )
  }
  return Number(match[1]) * (factors[match[2]?.toLowerCase()] ?? 1)
}

export const validatedPageGeometry = (geometry: NonNullable<PageLayoutOptions['geometry']>) => {
  const { widthMm, heightMm, marginMm, columns } = geometry
  if (
    ![widthMm, heightMm, marginMm].every(Number.isFinite) ||
    widthMm < 10 ||
    heightMm < 10 ||
    widthMm > 2000 ||
    heightMm > 2000 ||
    marginMm < 0 ||
    !Number.isInteger(columns) ||
    columns < 1 ||
    columns > 6
  ) {
    throw new Error('The document page geometry is invalid. Review the Page layout settings.')
  }
  if (marginMm * 2 >= Math.min(widthMm, heightMm)) {
    throw new Error('Page margins leave no printable area. Reduce the margins or increase the page dimensions.')
  }
  if (widthMm - marginMm * 2 <= (columns - 1) * 5) {
    throw new Error('Page columns leave no printable area. Reduce the columns or margins, or increase the page width.')
  }
  return geometry
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

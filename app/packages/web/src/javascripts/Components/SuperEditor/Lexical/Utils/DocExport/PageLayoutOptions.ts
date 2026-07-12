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
import type { HeaderFooterAlign, NoteLayout, PageNumberFormat } from '../../../Layout/layoutSettings'

/** Tokens a header/footer `text` may embed; substituted with live fields per generator. */
export const PAGE_TOKEN = '{page}'
export const TOTAL_TOKEN = '{total}'

export type PageLayoutOptions = {
  pageNumber?: {
    format: PageNumberFormat
    align: HeaderFooterAlign
    location: 'header' | 'footer'
    startAt: number
  }
  header?: { text: string; align: HeaderFooterAlign }
  footer?: { text: string; align: HeaderFooterAlign }
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
    options.header = { text: layout.header.text, align: layout.header.align }
  }
  if (layout.footer.enabled) {
    options.footer = { text: layout.footer.text, align: layout.footer.align }
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
export const pageStartOffset = (options: PageLayoutOptions): number =>
  options.pageNumber ? options.pageNumber.startAt - 1 : 0

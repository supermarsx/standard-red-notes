/**
 * Pure, framework-free helpers for rendering page numbers / header-footer text in
 * the PDF export. They live outside PDFWorker.worker.tsx (which can't be imported
 * in jest — it calls comlink `expose()` at module load and needs a Worker global)
 * so the numbering/format/token logic is unit-testable, while the worker just
 * consumes them inside its `<Text fixed render={...}>` callbacks.
 */
import type { PageNumberFormat } from '../../../Layout/layoutSettings'

/** Format a (already offset) page number per the chosen format. */
export const formatPdfPageNumber = (format: PageNumberFormat, pageNumber: number, totalPages: number): string => {
  switch (format) {
    case 'n':
      return String(pageNumber)
    case 'n-of-total':
      return `${pageNumber} / ${totalPages}`
    case 'page-n':
    default:
      return `Page ${pageNumber}`
  }
}

/**
 * Substitute `{page}` / `{total}` in a header/footer text. `offset` shifts the
 * displayed page number so it matches the docx/odt `startAt` semantics (page 1
 * shows `1 + offset`).
 */
export const substitutePageTokens = (
  text: string,
  pageNumber: number,
  totalPages: number,
  offset: number,
): string =>
  text.replace(/\{page\}/g, String(pageNumber + offset)).replace(/\{total\}/g, String(totalPages))

/** CSS `text-align` value for a header/footer alignment (identity, but typed). */
export const pdfTextAlign = (align: 'left' | 'center' | 'right'): 'left' | 'center' | 'right' => align

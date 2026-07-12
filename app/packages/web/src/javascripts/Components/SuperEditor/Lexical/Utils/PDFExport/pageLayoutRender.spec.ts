/**
 * Unit tests for the pure PDF page-layout render helpers. These are the numbering
 * / format / token-substitution logic that PDFWorker.worker.tsx feeds into its
 * `<Text fixed render={...}>` callbacks.
 *
 * The worker itself (comlink `expose()` + @react-pdf font registration + a real
 * Worker global) cannot be executed under jest, so the real pixel PDF output is
 * unverifiable in-env — these helpers are the testable seam that guarantees the
 * page-number strings and `{page}`/`{total}` tokens resolve correctly, including
 * the `startAt` offset that mirrors the docx/odt section-start semantics.
 */
import { formatPdfPageNumber, substitutePageTokens } from './pageLayoutRender'

describe('formatPdfPageNumber', () => {
  it('formats each supported format', () => {
    expect(formatPdfPageNumber('n', 4, 10)).toBe('4')
    expect(formatPdfPageNumber('n-of-total', 4, 10)).toBe('4 / 10')
    expect(formatPdfPageNumber('page-n', 4, 10)).toBe('Page 4')
  })

  it('reflects the offset already applied by the caller (startAt semantics)', () => {
    // Page 1 with startAt 3 ⇒ caller passes pageNumber + offset = 1 + 2 = 3.
    expect(formatPdfPageNumber('page-n', 3, 8)).toBe('Page 3')
  })
})

describe('substitutePageTokens', () => {
  it('replaces {page} and {total}, applying the start offset to {page}', () => {
    // pageNumber 1, offset 2 (startAt 3) ⇒ {page} shows 3; {total} is literal.
    expect(substitutePageTokens('Page {page} of {total}', 1, 8, 2)).toBe('Page 3 of 8')
  })

  it('replaces every occurrence and leaves plain text untouched', () => {
    expect(substitutePageTokens('{page}-{page}', 5, 5, 0)).toBe('5-5')
    expect(substitutePageTokens('no tokens here', 2, 9, 0)).toBe('no tokens here')
  })

  it('handles a zero offset (startAt 1) as an identity on the page number', () => {
    expect(substitutePageTokens('{page}/{total}', 4, 12, 0)).toBe('4/12')
  })
})

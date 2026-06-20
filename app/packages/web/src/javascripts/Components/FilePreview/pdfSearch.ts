/**
 * Pure helpers for the PDF "find in document" feature.
 *
 * These functions are deliberately free of any PDF.js / DOM dependency so they
 * can be unit-tested in isolation. The viewer extracts the text of each page
 * (via `page.getTextContent()`), feeds it here to locate matches, and uses the
 * returned offsets/page numbers to drive highlighting + scrolling.
 */

/** A single match located within a page's extracted text. */
export type PdfSearchMatch = {
  /** 1-based page number the match lives on. */
  pageNumber: number
  /** Character offset of the match within that page's joined text. */
  index: number
}

/** Per-page extracted text, keyed by 1-based page number. */
export type PdfPageText = {
  pageNumber: number
  text: string
}

/**
 * Find every (non-overlapping) occurrence of `query` within a single page's
 * text. Case-insensitive unless `matchCase` is set. Returns the start offsets
 * of each occurrence (within the supplied text).
 */
export function findMatchOffsetsInText(text: string, query: string, matchCase = false): number[] {
  const offsets: number[] = []
  if (!query) {
    return offsets
  }

  const haystack = matchCase ? text : text.toLowerCase()
  const needle = matchCase ? query : query.toLowerCase()
  if (needle.length === 0) {
    return offsets
  }

  let index = haystack.indexOf(needle)
  while (index !== -1) {
    offsets.push(index)
    // Advance past the current match to avoid overlapping duplicates.
    index = haystack.indexOf(needle, index + needle.length)
  }
  return offsets
}

/**
 * Locate all matches of `query` across the supplied pages, preserving document
 * order (page order, then offset order within a page). Returns a flat list so
 * the viewer can treat "next/previous match" as moving through a single index.
 */
export function findMatchesAcrossPages(pages: PdfPageText[], query: string, matchCase = false): PdfSearchMatch[] {
  const matches: PdfSearchMatch[] = []
  const trimmed = query.trim()
  if (trimmed.length === 0) {
    return matches
  }

  for (const page of pages) {
    const offsets = findMatchOffsetsInText(page.text, trimmed, matchCase)
    for (const index of offsets) {
      matches.push({ pageNumber: page.pageNumber, index })
    }
  }
  return matches
}

/**
 * Wrap a match index by `delta` over `total` matches. Wraps around both ends so
 * "next" past the last match returns to the first, and "previous" before the
 * first returns to the last. Returns 0 when there are no matches.
 */
export function wrapMatchIndex(current: number, delta: number, total: number): number {
  if (total <= 0) {
    return 0
  }
  return (((current + delta) % total) + total) % total
}

/**
 * Join a page's text-content items into a single searchable string, mirroring
 * what the viewer renders into the text layer. Items without a `str` (e.g.
 * marked-content markers) contribute nothing.
 */
export function joinTextItems(items: Array<{ str?: string } | unknown>): string {
  return items
    .map((item) => (item && typeof item === 'object' && 'str' in item ? String((item as { str?: string }).str ?? '') : ''))
    .join(' ')
}

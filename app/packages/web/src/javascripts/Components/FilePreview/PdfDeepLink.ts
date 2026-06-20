/**
 * PDF deep-link format (Obsidian-style)
 * -------------------------------------
 * A deep link points at a specific location inside a PDF file managed by the app.
 * It is a self-contained, copy/paste-able string of the form:
 *
 *   sn-file://<file-uuid>#page=<N>[&quote=<url-encoded text>]
 *
 *   sn-file://3f2a...e1#page=12
 *   sn-file://3f2a...e1#page=12&quote=the%20quick%20brown%20fox
 *
 * - `file-uuid`  identifies the FileItem to open (required).
 * - `page`       1-based page number to scroll to on open (optional).
 * - `quote`      a text fragment to find/highlight on that page (optional; the
 *                viewer searches for it and highlights the first match).
 *
 * The format is intentionally close to the standard `#page=N` PDF URL fragment
 * convention so it reads naturally, while the `sn-file://` scheme makes it
 * unambiguous that the target is an app-managed file (not an external URL).
 *
 * A note's `[[`/link system can store this string and, when clicked, hand the
 * parsed target to `filePreviewModalController.activate(file, others, target)`.
 */

export const SN_FILE_LINK_SCHEME = 'sn-file://'

export type PdfDeepLinkTarget = {
  /** Target page (1-based). */
  page?: number
  /** Text fragment to find/highlight within the document. */
  quote?: string
}

export type ParsedPdfDeepLink = PdfDeepLinkTarget & {
  fileUuid: string
}

/**
 * Build a shareable deep-link string for a file + optional location.
 */
export function formatPdfDeepLink(fileUuid: string, target: PdfDeepLinkTarget = {}): string {
  if (!fileUuid) {
    throw new Error('formatPdfDeepLink requires a file uuid')
  }

  const params: string[] = []

  if (typeof target.page === 'number' && Number.isFinite(target.page) && target.page >= 1) {
    params.push(`page=${Math.floor(target.page)}`)
  }

  if (target.quote && target.quote.trim().length > 0) {
    params.push(`quote=${encodeURIComponent(target.quote.trim())}`)
  }

  const fragment = params.length > 0 ? `#${params.join('&')}` : ''
  return `${SN_FILE_LINK_SCHEME}${fileUuid}${fragment}`
}

/**
 * Parse a deep-link string back into its parts. Returns `undefined` when the
 * string is not a valid `sn-file://` deep link.
 */
export function parsePdfDeepLink(link: string): ParsedPdfDeepLink | undefined {
  if (typeof link !== 'string') {
    return undefined
  }

  const trimmed = link.trim()
  if (!trimmed.toLowerCase().startsWith(SN_FILE_LINK_SCHEME)) {
    return undefined
  }

  const withoutScheme = trimmed.slice(SN_FILE_LINK_SCHEME.length)
  const hashIndex = withoutScheme.indexOf('#')
  const fileUuid = (hashIndex === -1 ? withoutScheme : withoutScheme.slice(0, hashIndex)).trim()

  if (!fileUuid) {
    return undefined
  }

  const result: ParsedPdfDeepLink = { fileUuid }

  if (hashIndex !== -1) {
    const fragment = withoutScheme.slice(hashIndex + 1)
    const parsed = parsePdfFragment(fragment)
    if (parsed.page !== undefined) {
      result.page = parsed.page
    }
    if (parsed.quote !== undefined) {
      result.quote = parsed.quote
    }
  }

  return result
}

/**
 * Parse the location portion (`page=N&quote=...`) of a deep link. Also accepts a
 * bare `#page=N` fragment (e.g. when invoked from a plain PDF URL anchor), so the
 * viewer can be opened at a page from either a full deep link or a URL hash.
 */
export function parsePdfFragment(fragment: string): PdfDeepLinkTarget {
  const target: PdfDeepLinkTarget = {}

  if (!fragment) {
    return target
  }

  const cleaned = fragment.startsWith('#') ? fragment.slice(1) : fragment

  for (const part of cleaned.split('&')) {
    const eqIndex = part.indexOf('=')
    if (eqIndex === -1) {
      continue
    }
    const key = part.slice(0, eqIndex).trim().toLowerCase()
    const rawValue = part.slice(eqIndex + 1)

    if (key === 'page') {
      const page = parseInt(rawValue, 10)
      if (Number.isFinite(page) && page >= 1) {
        target.page = page
      }
    } else if (key === 'quote') {
      try {
        const decoded = decodeURIComponent(rawValue)
        if (decoded.trim().length > 0) {
          target.quote = decoded
        }
      } catch {
        // Malformed encoding -> ignore the quote rather than throwing.
      }
    }
  }

  return target
}

export function isPdfDeepLink(link: string): boolean {
  return typeof link === 'string' && link.trim().toLowerCase().startsWith(SN_FILE_LINK_SCHEME)
}

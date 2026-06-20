/**
 * Pure URL validator/normalizer for the Super editor "Web page" embed block.
 *
 * Unlike the YouTube/Vimeo `toEmbedUrl` normalizer, this block embeds an
 * arbitrary web page directly in a sandboxed iframe. Because the iframe `src`
 * is loaded straight from a remote origin, we only allow http(s) URLs and
 * explicitly reject dangerous schemes (`javascript:`, `data:`, `blob:`,
 * `file:`, `vbscript:`, etc.) which could otherwise execute in the editor's
 * context or smuggle markup into the frame.
 *
 * Returns the normalized absolute URL string when valid, or '' when the input
 * is empty/invalid. Callers treat '' as "not loadable".
 */
export function sanitizeWebEmbedUrl(raw: string | null | undefined): string {
  const input = (raw || '').trim()
  if (!input) {
    return ''
  }

  // Require an explicit http/https scheme up front. We intentionally do NOT
  // auto-prepend https:// for scheme-less input, so that strings like
  // "javascript:alert(1)" can never be coerced into a "valid" URL, and so the
  // user is always aware they are embedding an external origin.
  if (!/^https?:\/\//i.test(input)) {
    return ''
  }

  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    return ''
  }

  // Belt-and-suspenders: only allow the http/https protocols.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return ''
  }

  // Reject URLs without a host (e.g. "http:///foo").
  if (!parsed.hostname) {
    return ''
  }

  return parsed.toString()
}

/**
 * Convenience predicate mirroring sanitizeWebEmbedUrl for readability at call
 * sites that just need a boolean.
 */
export function isValidWebEmbedUrl(raw: string | null | undefined): boolean {
  return sanitizeWebEmbedUrl(raw) !== ''
}

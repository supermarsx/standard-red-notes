/**
 * Pure URL validator/normalizer for the Super editor "Web page" embed block.
 *
 * Unlike the YouTube/Vimeo `toEmbedUrl` normalizer, this block embeds an
 * arbitrary web page directly in a sandboxed iframe. Because the iframe `src`
 * is loaded straight from a remote origin, we only allow cross-origin HTTPS
 * URLs and explicitly reject dangerous schemes (`javascript:`, `data:`,
 * `blob:`, `file:`, `vbscript:`, etc.) which could otherwise execute in the
 * editor's context or smuggle markup into the frame. Plain HTTP is rejected so
 * a persisted embed can never downgrade transport security or require a mixed-
 * content exception that production CSP deliberately does not provide.
 *
 * Returns the normalized absolute URL string when valid, or '' when the input
 * is empty/invalid. Callers treat '' as "not loadable".
 */
function getRuntimeOrigin(): string | undefined {
  return typeof window === 'undefined' ? undefined : window.location.origin
}

function getHttpOrigin(raw: string | null | undefined): string | undefined {
  if (!raw) {
    return undefined
  }

  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined
  } catch {
    return undefined
  }
}

export function sanitizeWebEmbedUrl(
  raw: string | null | undefined,
  currentOrigin: string | null | undefined = getRuntimeOrigin(),
): string {
  const input = (raw || '').trim()
  if (!input) {
    return ''
  }

  // Require an explicit HTTPS scheme up front. We intentionally do NOT
  // auto-prepend https:// for scheme-less input, so that strings like
  // "javascript:alert(1)" can never be coerced into a "valid" URL, and so the
  // user is always aware they are embedding an external origin.
  if (!/^https:\/\//i.test(input)) {
    return ''
  }

  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    return ''
  }

  // Belt-and-suspenders: only encrypted HTTPS embeds are supported.
  if (parsed.protocol !== 'https:') {
    return ''
  }

  // Reject URLs without a host (e.g. "http:///foo").
  if (!parsed.hostname) {
    return ''
  }

  // The iframe intentionally combines allow-scripts with allow-same-origin so
  // modern external apps can use their own storage and APIs. That combination
  // must never be used for a document on the Standard Notes origin: a
  // same-origin frame could otherwise reach the parent app's DOM and storage.
  //
  // Resolve the origin for every call instead of at module load so persisted
  // embeds are re-evaluated after a deployment, navigation, or host change.
  const runtimeHttpOrigin = getHttpOrigin(currentOrigin)
  if (runtimeHttpOrigin && parsed.origin === runtimeHttpOrigin) {
    return ''
  }

  return parsed.toString()
}

/**
 * Convenience predicate mirroring sanitizeWebEmbedUrl for readability at call
 * sites that just need a boolean.
 */
export function isValidWebEmbedUrl(
  raw: string | null | undefined,
  currentOrigin: string | null | undefined = getRuntimeOrigin(),
): boolean {
  return sanitizeWebEmbedUrl(raw, currentOrigin) !== ''
}

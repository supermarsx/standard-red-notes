/**
 * Pure CORS-origin decision for the api-gateway.
 *
 * SECURITY DEFAULT: strict. Historically the gateway reflected ANY Origin with
 * `credentials: true` unless the operator opted into strict mode, and even in
 * strict mode an EMPTY allow-list short-circuited to "reflect anything". That
 * means a stock self-host would echo back an attacker's Origin together with
 * Access-Control-Allow-Credentials, defeating the browser's cross-site
 * protection. We now default to strict and only allow origins that legitimately
 * need cross-origin credentialed access:
 *
 *   - the desktop app          (Origin: file://... , or a "not filled"/null Origin)
 *   - the Firefox clipper       (Origin: moz-extension://...)
 *   - the Chromium clipper       (Origin: chrome-extension://...)   [manifest v3]
 *   - the Safari clipper         (Origin: safari-web-extension://...)
 *   - a localhost self-host      (Origin: http(s)://localhost[:port])
 *   - anything the operator explicitly lists in CORS_ALLOWED_ORIGINS
 *
 * Everything else is disallowed. NOTE on same-origin: the caller emits NO
 * Access-Control-Allow-Origin header for a disallowed origin (rather than
 * throwing), so SAME-ORIGIN requests — which don't need CORS at all — keep
 * working on any custom domain; only genuine CROSS-origin callers are blocked
 * by the browser.
 *
 * Extension-scheme allowances are safe: a web page cannot forge an
 * `moz-extension://` / `chrome-extension://` Origin, so listing those schemes
 * does not widen the web attack surface.
 *
 * Escape hatch: setting CORS_ORIGIN_STRICT_MODE_ENABLED=false restores the
 * legacy permissive "reflect any Origin" behavior (strictMode=false here).
 */
export interface CorsOriginDecisionConfig {
  /** When false, reflect any origin (legacy permissive behavior / escape hatch). */
  strictMode: boolean
  /** Operator-configured additional allowed origins (CORS_ALLOWED_ORIGINS). */
  allowedOrigins: string[]
}

export interface CorsOriginDecision {
  allow: boolean
}

const LOCALHOST_ORIGIN = /^https?:\/\/localhost(:\d+)?$/

export const decideCorsOrigin = (
  requestOrigin: string | undefined,
  config: CorsOriginDecisionConfig,
): CorsOriginDecision => {
  // Escape hatch: strict mode OFF => reflect whatever Origin was sent.
  if (!config.strictMode) {
    return { allow: true }
  }

  // No Origin header (or the literal "null") => not a browser cross-origin
  // request we need to gate (native apps, server-to-server, same-origin GET).
  if (!requestOrigin || requestOrigin === 'null') {
    return { allow: true }
  }

  const isDesktopApp = requestOrigin.startsWith('file://')
  const isFirefoxClipper = requestOrigin.startsWith('moz-extension://')
  const isChromiumClipper = requestOrigin.startsWith('chrome-extension://')
  const isSafariClipper = requestOrigin.startsWith('safari-web-extension://')
  const isLocalhostApp = LOCALHOST_ORIGIN.test(requestOrigin)
  const isExplicitlyAllowed = config.allowedOrigins.includes(requestOrigin)

  return {
    allow:
      isDesktopApp ||
      isFirefoxClipper ||
      isChromiumClipper ||
      isSafariClipper ||
      isLocalhostApp ||
      isExplicitlyAllowed,
  }
}

/**
 * Resolve strict mode from the raw CORS_ORIGIN_STRICT_MODE_ENABLED value.
 * Default (unset) is STRICT; only the explicit string "false" disables it.
 */
export const resolveCorsStrictMode = (raw: string | undefined): boolean => {
  return raw !== 'false'
}

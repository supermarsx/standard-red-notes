import { SESSION_ACCESS_TOKEN_COOKIE_PREFIX, SyncTicketIdentity } from '@standard-red-notes/websocket-gateway'

/**
 * Standard Red Notes: the session credential the socket lanes were missing.
 *
 * A cookie-based session (auth's `SessionService.COOKIE_SESSION_TOKEN_VERSION`) is
 * authenticated by `GetSessionFromToken` ONLY through `authCookies`; its header-token
 * branch explicitly refuses a session whose `version === COOKIE_BASED_SESSION_VERSION`.
 * `AuthMiddleware` parses `request.headers.cookie` and passes the result on every
 * ordinary HTTP request. The socket lanes revalidate the same session out of a ticket,
 * so the ticket has to carry the same thing or the lane can never authenticate.
 *
 * Only `access_token_*` cookies are captured. The rest of a browser's cookie jar is
 * not needed to authenticate and must not be copied into a store.
 */
export function captureSessionCookies(cookieHeader: string | undefined): SyncTicketIdentity['sessionCookies'] {
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) {
    return undefined
  }

  const captured: Record<string, string[]> = {}
  for (const pair of cookieHeader.split(';')) {
    const separator = pair.indexOf('=')
    if (separator <= 0) {
      continue
    }
    // Split on the FIRST '=' rather than requiring exactly two parts, so a value
    // carrying base64 padding is preserved instead of silently dropped.
    const name = pair.slice(0, separator).trim()
    const value = pair.slice(separator + 1).trim()
    if (!name.startsWith(SESSION_ACCESS_TOKEN_COOKIE_PREFIX) || value.length === 0) {
      continue
    }
    const existing = captured[name]
    if (existing) {
      existing.push(value)
    } else {
      captured[name] = [value]
    }
  }

  return Object.keys(captured).length > 0 ? captured : undefined
}

/**
 * The shape `ServiceProxyInterface.validateSession` takes, which is also the shape
 * `AuthMiddleware` builds — so the socket lanes and the HTTP path hand auth the same
 * thing and cannot diverge.
 */
export function sessionCookiesToMap(cookies: SyncTicketIdentity['sessionCookies']): Map<string, string[]> | undefined {
  if (!cookies) {
    return undefined
  }
  const map = new Map<string, string[]>()
  for (const [name, values] of Object.entries(cookies)) {
    map.set(name, [...values])
  }
  return map.size > 0 ? map : undefined
}

/**
 * For the loopback API_RPC lane, which does not call `validateSession` directly: it
 * re-enters the gateway over HTTP, so its credential has to travel as a real `Cookie`
 * header for `AuthMiddleware` to parse it back out.
 */
export function sessionCookiesToHeader(cookies: SyncTicketIdentity['sessionCookies']): string | undefined {
  if (!cookies) {
    return undefined
  }
  const pairs: string[] = []
  for (const [name, values] of Object.entries(cookies)) {
    for (const value of values) {
      pairs.push(`${name}=${value}`)
    }
  }
  return pairs.length > 0 ? pairs.join('; ') : undefined
}

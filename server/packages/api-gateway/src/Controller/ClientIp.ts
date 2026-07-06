import { Request } from 'express'

import { normalizeIp } from './IpAccessList'

/**
 * Standard Red Notes: THE canonical client-IP resolver for the gateway.
 *
 * Every place that needs "the client's IP address" — rate limiting, the IP
 * allow/block list, the auth session/security IP forwarded to the auth server
 * (x-origin-ip), the workflows audit log — MUST route through `resolveClientIp`
 * so a single request yields the SAME address everywhere. Divergence here is a
 * security bug: it lets an attacker spoof one consumer (e.g. the recorded
 * session IP) while another (the rate limiter) sees a different value.
 *
 * SECURITY MODEL — resolution is layered so a DIRECT (non-proxied) client can
 * never spoof its address:
 *
 *   1. If (and only if) the operator explicitly sets `CLIENT_IP_HEADER`, the
 *      named header is read (leftmost value, normalized) and takes precedence.
 *      This is for deployments behind a proxy/CDN that sets a single trusted
 *      client-IP header (e.g. `X-Real-IP`, Cloudflare `CF-Connecting-IP`) AND
 *      strips any inbound copy. It is OFF by default because, without such a
 *      proxy, a client can send the header itself — see docs/DEPLOYMENT.md.
 *
 *   2. Otherwise Express `request.ip` is used. Express only derives that from
 *      `X-Forwarded-For` when `trust proxy` is configured (see TrustProxy.ts),
 *      and only trusts hops it is told to. With the safe default (loopback /
 *      linklocal / uniquelocal) a remote client's forged `X-Forwarded-For` is
 *      ignored and `request.ip` is its real socket address.
 *
 *   3. Falls back to the raw socket address, then '' when nothing is available.
 *
 * All results are normalized (IPv6 zone id dropped, IPv4-mapped IPv6
 * `::ffff:1.2.3.4` unwrapped to dotted-quad, IPv6 lower-cased) via the same
 * `normalizeIp` the IP allow/block list uses, so keys/matches line up exactly.
 *
 * With NEITHER `TRUST_PROXY` nor `CLIENT_IP_HEADER` set beyond the existing
 * default, this returns exactly today's `request.ip` (normalized) — the
 * behavior is unchanged and a direct client CANNOT spoof its IP.
 */

/** OFF by default: no trusted client-IP header is read unless the operator sets one. */
export const DEFAULT_CLIENT_IP_HEADER = ''

/**
 * Normalize the configured header NAME (env `CLIENT_IP_HEADER`) to the lower-case
 * form Node stores request headers under. Empty / unset => the feature is off.
 */
export const parseClientIpHeaderName = (raw: string | undefined | null): string => {
  if (raw === undefined || raw === null) {
    return DEFAULT_CLIENT_IP_HEADER
  }

  return raw.trim().toLowerCase()
}

/** Minimal structural slice of an Express request the resolver needs (unit-testable). */
export interface ClientIpResolvable {
  ip?: string
  socket?: { remoteAddress?: string } | null
  headers: Record<string, string | string[] | undefined>
}

/** Extract + normalize the leftmost IP from a (possibly comma-joined / array) header value. */
const firstHeaderIp = (value: string | string[] | undefined): string => {
  if (value === undefined) {
    return ''
  }
  const single = Array.isArray(value) ? value[0] : value
  if (single === undefined) {
    return ''
  }
  const leftmost = single.split(',')[0]?.trim() ?? ''

  return normalizeIp(leftmost)
}

/**
 * Resolve the trust-proxy-correct client IP for a request. `clientIpHeader` is
 * the (already parsed) configured header name, or empty/undefined for the
 * default request.ip behavior. See the file docblock for the full security model.
 */
export const resolveClientIp = (request: ClientIpResolvable, clientIpHeader?: string): string => {
  const headerName = parseClientIpHeaderName(clientIpHeader)
  if (headerName !== '') {
    const fromHeader = firstHeaderIp(request.headers[headerName])
    if (fromHeader !== '') {
      return fromHeader
    }
    // Header configured but absent on this request: fall through to request.ip
    // rather than returning '' so a missing header degrades gracefully.
  }

  const direct = request.ip ?? request.socket?.remoteAddress ?? ''

  return normalizeIp(direct)
}

/** Convenience overload for callers holding a full Express Request. */
export const resolveClientIpFromRequest = (request: Request, clientIpHeader?: string): string =>
  resolveClientIp(request as unknown as ClientIpResolvable, clientIpHeader)

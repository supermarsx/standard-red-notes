/**
 * Standard Red Notes: shared, dependency-light SSRF URL validator.
 *
 * WHY THIS EXISTS: several server-side features take a user-controlled URL and
 * make an outbound request to it (outbound webhooks, the Nextcloud WebDAV
 * backup target). Each of those is an SSRF target. The api-gateway already has a
 * battle-tested copy of this logic inside its WebService, but the `auth` and
 * `syncing-server` packages cannot cleanly import from api-gateway, so this is a
 * small reusable copy living in domain-core (which both packages already depend
 * on). It uses only Node built-ins (`dns/promises` + `net`).
 *
 * `assertPublicHttpUrl(rawUrl)` rejects non-http(s) schemes and any host literal
 * or DNS-resolved address that is private / loopback / link-local / unique-local
 * / cloud-metadata / CGNAT / multicast / NAT64 / IPv4-mapped.
 *
 * Residual: a DNS-rebinding TOCTOU window remains between this resolution and
 * the socket connect (the OS re-resolves). Operators should also restrict egress
 * at the network layer; connection-time IP pinning is a future hardening. This
 * is why callers are expected to re-validate at delivery time (not just at the
 * point of registration) and to disable redirect-following.
 */

import { lookup } from 'dns/promises'
import { isIP } from 'net'

export class SsrfValidationError extends Error {
  constructor(
    message: string,
    readonly tag: string = 'invalid-input',
  ) {
    super(message)
    this.name = 'SsrfValidationError'
  }
}

export type ResolveHost = (host: string) => Promise<string[]>

async function defaultResolveHost(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true })
  return records.map((record) => record.address)
}

/**
 * Parse + validate a URL for a server-side outbound request. Rejects non-http(s)
 * schemes and any host literal or DNS-resolved address that is private /
 * loopback / link-local / unique-local / cloud-metadata. Throws
 * {@link SsrfValidationError} (safe message) on any rejection; returns the parsed
 * {@link URL} on success.
 *
 * `resolveHost` is injectable for tests; it defaults to the real DNS resolver.
 */
export async function assertPublicHttpUrl(rawUrl: string, resolveHost: ResolveHost = defaultResolveHost): Promise<URL> {
  const value = typeof rawUrl === 'string' ? rawUrl.trim() : ''
  if (value.length === 0) {
    throw new SsrfValidationError('A URL is required.', 'missing-url')
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new SsrfValidationError('The URL is malformed.', 'invalid-url')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfValidationError('Only http(s) URLs are allowed.', 'invalid-scheme')
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (isBlockedHostname(host)) {
    throw new SsrfValidationError('The requested host is not allowed.', 'blocked-host')
  }

  // Literal IPs are checked directly; hostnames are resolved and EVERY resolved
  // address must be public (defends against DNS-rebinding to a private address
  // and against names that resolve to metadata IPs).
  if (isIP(host)) {
    if (isBlockedIp(host)) {
      throw new SsrfValidationError('The requested host is not allowed.', 'blocked-host')
    }
  } else {
    let addresses: string[]
    try {
      addresses = await resolveHost(host)
    } catch {
      throw new SsrfValidationError('The host could not be resolved.', 'unresolvable-host')
    }
    if (addresses.length === 0 || addresses.some((address) => isBlockedIp(address))) {
      throw new SsrfValidationError('The requested host is not allowed.', 'blocked-host')
    }
  }

  return url
}

// Hostname-level blocks (before/independent of IP resolution).
export function isBlockedHostname(host: string): boolean {
  if (host.length === 0) {
    return true
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true
  }
  // RFC 6761 / common internal TLDs and cloud metadata names.
  if (host.endsWith('.internal') || host.endsWith('.local') || host === 'metadata' || host.endsWith('.metadata')) {
    return true
  }
  return false
}

/**
 * Returns true if an IP literal is private, loopback, link-local (incl. the
 * 169.254.169.254 cloud metadata address), unique-local, or otherwise not a
 * routable public address.
 */
export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip)
  if (family === 4) {
    return isBlockedIpv4(ip)
  }
  if (family === 6) {
    return isBlockedIpv6(ip)
  }
  // Not a parseable IP -> treat as blocked (fail closed).
  return true
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10))
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true
  }
  const [a, b] = parts
  // "this" network 0.0.0.0/8
  if (a === 0) {
    return true
  }
  // private 10.0.0.0/8
  if (a === 10) {
    return true
  }
  // loopback 127.0.0.0/8
  if (a === 127) {
    return true
  }
  // link-local 169.254.0.0/16 (includes the 169.254.169.254 cloud metadata IP)
  if (a === 169 && b === 254) {
    return true
  }
  // private 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) {
    return true
  }
  // private 192.168.0.0/16
  if (a === 192 && b === 168) {
    return true
  }
  // CGNAT 100.64.0.0/10
  if (a === 100 && b >= 64 && b <= 127) {
    return true
  }
  // multicast + reserved 224.0.0.0/3
  if (a >= 224) {
    return true
  }
  return false
}

const hextetsToIpv4 = (high: number, low: number): string =>
  `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`

function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  // loopback ::1 / unspecified ::
  if (lower === '::1' || lower === '::') {
    return true
  }
  // IPv4-mapped (::ffff:…) and NAT64 (64:ff9b::…) embed an IPv4 address that can
  // point at a private/loopback host — extract and validate it. Both the dotted
  // (a.b.c.d) and the non-dotted hextet (HHHH:HHHH) encodings are handled.
  const dotted = lower.match(/(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    return isBlockedIpv4(dotted[1])
  }
  const hex = lower.match(/(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hex) {
    return isBlockedIpv4(hextetsToIpv4(parseInt(hex[1], 16), parseInt(hex[2], 16)))
  }
  // Any other address in the NAT64 well-known prefix — fail closed.
  if (lower.startsWith('64:ff9b:')) {
    return true
  }
  // link-local fe80::/10
  if (lower.startsWith('fe80')) {
    return true
  }
  // unique-local fc00::/7
  if (lower.startsWith('fc') || lower.startsWith('fd')) {
    return true
  }
  // multicast ff00::/8
  if (lower.startsWith('ff')) {
    return true
  }
  return false
}

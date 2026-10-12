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
 * `assertPublicHttpUrl` is suitable for validation-only flows such as saving a
 * target. Code that actually sends a request must use `PinnedHttpTransport`,
 * which consumes the validated address set without a second DNS lookup and
 * repeats that resolution/pinning for redirects.
 */

import { lookup } from 'dns/promises'
import { BlockList, isIP } from 'net'

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

export interface ResolvedPublicHttpUrl {
  url: URL
  addresses: ReadonlyArray<{
    address: string
    family: 4 | 6
  }>
}

export interface OutboundHttpResolutionPolicy {
  /**
   * Exact origins explicitly trusted by the operator. These origins may
   * resolve to non-public addresses, but still use the returned address for a
   * pinned connection and still reject malformed URLs and non-HTTP schemes.
   */
  allowedPrivateOrigins?: ReadonlySet<string>
  /**
   * How far that operator trust reaches.
   *
   * `'any'` is the default and the historical behaviour: a trusted origin skips
   * every address check, so it may resolve to loopback or to the cloud metadata
   * address. That is right for an address the operator typed into the server's
   * own configuration and wrong for an address a USER typed that merely happens
   * to be on an operator's list.
   *
   * `'private-ranges'` lets a trusted origin resolve to a public address or to
   * RFC 1918, carrier-grade NAT and unique-local space, and to nothing else:
   * loopback, link-local (169.254.169.254 included), unspecified, multicast and
   * every other special range stay refused whatever the operator listed. See
   * {@link isOperatorAllowablePrivateIp}.
   */
  allowedPrivateOriginScope?: 'any' | 'private-ranges'
  /**
   * Refuses an address whatever else is true about it, trusted origin or not.
   * Used to keep a deployment's own services out of reach by address as well as
   * by name. It is consulted for literal hosts and for every DNS answer.
   */
  isAddressDenied?: (address: string) => boolean
}

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
  return (await resolvePublicHttpUrl(rawUrl, resolveHost)).url
}

/**
 * Resolve and validate a URL for an outbound connection in one operation. Every
 * DNS answer must be public; callers can then connect directly to one address
 * from this immutable result without asking DNS a second time.
 */
export async function resolvePublicHttpUrl(
  rawUrl: string,
  resolveHost: ResolveHost = defaultResolveHost,
): Promise<ResolvedPublicHttpUrl> {
  return resolveHttpUrlForOutboundConnection(rawUrl, resolveHost)
}

/**
 * Resolve a URL into the immutable address set used by an outbound socket.
 * Public addresses are the default. A separately constructed operator-trust
 * path may opt an exact origin into private addressing without weakening any
 * other origin.
 */
export async function resolveHttpUrlForOutboundConnection(
  rawUrl: string,
  resolveHost: ResolveHost = defaultResolveHost,
  policy: OutboundHttpResolutionPolicy = {},
): Promise<ResolvedPublicHttpUrl> {
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
  const isAllowedPrivateOrigin = policy.allowedPrivateOrigins?.has(url.origin) ?? false
  if (!isAllowedPrivateOrigin && isBlockedHostname(host)) {
    throw new SsrfValidationError('The requested host is not allowed.', 'blocked-host')
  }

  // One rule for a literal host and for every DNS answer, so the two paths
  // cannot drift apart. A denied address is refused first and unconditionally.
  const isRefusedAddress = (address: string): boolean => {
    if (policy.isAddressDenied?.(address) === true) {
      return true
    }
    if (!isBlockedIp(address)) {
      return false
    }
    if (!isAllowedPrivateOrigin) {
      return true
    }
    return policy.allowedPrivateOriginScope === 'private-ranges' && !isOperatorAllowablePrivateIp(address)
  }

  // Literal IPs are checked directly; hostnames are resolved and EVERY resolved
  // address must be public (defends against DNS-rebinding to a private address
  // and against names that resolve to metadata IPs).
  let addresses: string[]
  if (isIP(host)) {
    if (isRefusedAddress(host)) {
      throw new SsrfValidationError('The requested host is not allowed.', 'blocked-host')
    }
    addresses = [host]
  } else {
    try {
      addresses = await resolveHost(host)
    } catch {
      throw new SsrfValidationError('The host could not be resolved.', 'unresolvable-host')
    }
    if (addresses.length === 0 || addresses.some((address) => !isIP(address) || isRefusedAddress(address))) {
      throw new SsrfValidationError('The requested host is not allowed.', 'blocked-host')
    }
  }

  return {
    url,
    addresses: addresses.map((address) => ({
      address,
      family: isIP(address) as 4 | 6,
    })),
  }
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
  if (typeof ip !== 'string' || ip.includes('%')) {
    return true
  }
  try {
    const family = isIP(ip)
    if (family === 4) {
      return isBlockedIpv4(ip)
    }
    if (family === 6) {
      return isBlockedIpv6(ip)
    }
  } catch {
    // Address parsing and range matching must always fail closed.
  }
  // Not a parseable IP -> treat as blocked (fail closed).
  return true
}

const blockedIpv4Ranges = new BlockList()

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const) {
  blockedIpv4Ranges.addSubnet(network, prefix, 'ipv4')
}

function isBlockedIpv4(ip: string): boolean {
  return blockedIpv4Ranges.check(ip, 'ipv4')
}

/**
 * The private space an operator can open to a trusted origin under the
 * `'private-ranges'` scope: where a self-hosted service on a LAN, a VPN or a
 * container network actually lives.
 *
 * It is a list of what is ALLOWED, not of what is forbidden, so an address
 * class nobody thought about stays refused. Deliberately absent: loopback
 * (127.0.0.0/8, ::1), link-local (169.254.0.0/16 with the cloud metadata
 * address, fe80::/10), the unspecified addresses, multicast, and IPv4-mapped
 * IPv6 — a mapped answer is never how a real service is published, and
 * admitting it would let `::ffff:127.0.0.1` ride in on the IPv4 rule.
 */
const operatorAllowablePrivateRanges = new BlockList()

for (const [network, prefix] of [
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const) {
  operatorAllowablePrivateRanges.addSubnet(network, prefix, 'ipv4')
}
operatorAllowablePrivateRanges.addSubnet('fc00::', 7, 'ipv6')

const ipv4MappedRange = new BlockList()
ipv4MappedRange.addSubnet('::ffff:0:0', 96, 'ipv6')

export function isOperatorAllowablePrivateIp(ip: string): boolean {
  if (typeof ip !== 'string' || ip.includes('%')) {
    return false
  }
  try {
    const family = isIP(ip)
    if (family === 4) {
      return operatorAllowablePrivateRanges.check(ip, 'ipv4')
    }
    if (family === 6) {
      // BlockList matches an IPv4 rule against an IPv4-mapped IPv6 address, so
      // the mapped form has to be turned away before the range check.
      return !ipv4MappedRange.check(ip, 'ipv6') && operatorAllowablePrivateRanges.check(ip, 'ipv6')
    }
  } catch {
    // Unparseable input is never allowable.
  }
  return false
}

/**
 * IPv6 spellings are deliberately not inspected as strings. Node's BlockList
 * parses and normalizes compressed, expanded, mixed IPv4/IPv6, and scoped
 * forms before applying the prefix, closing equivalent-address bypasses.
 *
 * Only the currently allocated global-unicast space is admitted. Special
 * ranges inside it are denied explicitly; everything outside it (including
 * mapped, NAT64, ULA, link/site-local, multicast, and reserved space) fails
 * closed. Transition ranges are unnecessary for ordinary public HTTP targets.
 */
const globalIpv6UnicastRange = new BlockList()
globalIpv6UnicastRange.addSubnet('2000::', 3, 'ipv6')

const blockedIpv6Ranges = new BlockList()

for (const [network, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const) {
  blockedIpv6Ranges.addSubnet(network, prefix, 'ipv6')
}

function isBlockedIpv6(ip: string): boolean {
  return !globalIpv6UnicastRange.check(ip, 'ipv6') || blockedIpv6Ranges.check(ip, 'ipv6')
}

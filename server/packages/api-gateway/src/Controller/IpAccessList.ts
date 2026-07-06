/**
 * Standard Red Notes: admin-managed IP ALLOW/BLOCK lists for the gateway, enforced
 * by the RateLimitMiddleware BEFORE the per-tier rate limiting runs.
 *
 *   - a BLOCKLISTED client IP is rejected outright (403) — it never reaches an
 *     auth/sync endpoint;
 *   - an ALLOWLISTED client IP BYPASSES the rate-limit tiers entirely (an
 *     operator's own automation / office range should never be throttled).
 *
 * PRECEDENCE: allow WINS over block, so an admin who blocks a broad range but
 * allowlists their own address can never lock themselves out.
 *
 * STORAGE: two Redis SETs (`rl:acl:allow`, `rl:acl:block`) of validated entries,
 * shared with the auth container's srn-admin CLI (same REDIS_URL in the
 * single-container image). Entries are plain IPv4/IPv4-CIDR/IPv6 strings; the
 * middleware loads them (cached briefly) and matches in pure integer/string math,
 * so there is no injection surface. Every entry is VALIDATED on write.
 *
 * FAIL-OPEN: a Redis error while classifying degrades to 'none' (neither blocked
 * nor allowed) so the request falls through to normal rate limiting — a cache
 * outage must never hard-block legitimate traffic. This is stated in the design
 * notes: blocklist enforcement is best-effort and fails open, exactly like the
 * rate limiter.
 */

export const IP_ACL_ALLOW_KEY = 'rl:acl:allow'
export const IP_ACL_BLOCK_KEY = 'rl:acl:block'

export type IpAclDecision = 'allowed' | 'blocked' | 'none'
export type IpAclList = 'allow' | 'block'

/** Minimal slice of ioredis this module needs (keeps it unit-testable). */
export interface IpAccessListRedis {
  sadd(key: string, member: string): Promise<number>
  srem(key: string, member: string): Promise<number>
  smembers(key: string): Promise<string[]>
}

/**
 * Strip an IPv6 zone id and unwrap an IPv4-mapped IPv6 address so the same
 * client is matched whether Express reports it as `1.2.3.4` or `::ffff:1.2.3.4`.
 * Lower-cases IPv6 for stable exact comparison. Returns '' for junk.
 */
export const normalizeIp = (raw: string): string => {
  if (typeof raw !== 'string') {
    return ''
  }
  let ip = raw.trim()
  if (ip === '') {
    return ''
  }
  // Drop an IPv6 zone/scope id ("fe80::1%eth0").
  const percentAt = ip.indexOf('%')
  if (percentAt >= 0) {
    ip = ip.slice(0, percentAt)
  }
  // Unwrap IPv4-mapped/compatible IPv6 ("::ffff:1.2.3.4" / "::1.2.3.4").
  const mapped = ip.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i)
  if (mapped) {
    return mapped[1]
  }

  return ip.includes(':') ? ip.toLowerCase() : ip
}

const IPV4_OCTETS = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** Parse a dotted-quad into a 32-bit unsigned int, or null when out of range. */
export const ipv4ToInt = (ip: string): number | null => {
  const match = ip.match(IPV4_OCTETS)
  if (!match) {
    return null
  }
  let value = 0
  for (let i = 1; i <= 4; i++) {
    const octet = Number(match[i])
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      return null
    }
    value = value * 256 + octet
  }

  return value >>> 0
}

/**
 * Validate + canonicalize an allow/block entry to the string that gets stored.
 * Accepts an exact IPv4, an IPv4 CIDR (`a.b.c.d/0..32`) or a plausible IPv6
 * literal (exact match only — IPv6 CIDR is NOT supported and is rejected here so
 * an admin is never misled into thinking a `/64` is enforced). Guards the input
 * character set + length so nothing but an IP-shaped token is ever persisted.
 */
export const validateIpAclEntry = (raw: unknown): { ok: true; value: string } | { ok: false; error: string } => {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Entry must be a string.' }
  }
  const entry = raw.trim().toLowerCase()
  if (entry.length === 0 || entry.length > 49) {
    return { ok: false, error: 'Entry must be a non-empty IP or CIDR string.' }
  }
  // Only IP/CIDR-shaped characters — hard guard against any injection payload.
  if (!/^[0-9a-f:.\/]+$/.test(entry)) {
    return { ok: false, error: `"${raw}" is not a valid IP or CIDR.` }
  }

  const slashAt = entry.indexOf('/')
  if (slashAt >= 0) {
    const base = entry.slice(0, slashAt)
    const bitsRaw = entry.slice(slashAt + 1)
    // Only IPv4 CIDR is enforceable here.
    if (ipv4ToInt(base) === null) {
      return { ok: false, error: `"${raw}" is not a valid IPv4 CIDR (IPv6 CIDR is not supported).` }
    }
    const bits = Number(bitsRaw)
    if (!/^\d{1,2}$/.test(bitsRaw) || !Number.isInteger(bits) || bits < 0 || bits > 32) {
      return { ok: false, error: `"${raw}" has an invalid CIDR prefix (expected /0../32).` }
    }

    return { ok: true, value: `${base}/${bits}` }
  }

  if (ipv4ToInt(entry) !== null) {
    return { ok: true, value: entry }
  }

  // Bare IPv6 literal (exact match). Require at least one ':' and a hextet shape.
  if (entry.includes(':') && /^[0-9a-f:]+$/.test(entry) && entry.split(':').length <= 8 + 1) {
    return { ok: true, value: normalizeIp(entry) }
  }

  return { ok: false, error: `"${raw}" is not a valid IP or CIDR.` }
}

/**
 * Does a (normalized) client IP fall under a stored entry? IPv4 exact + IPv4
 * CIDR are matched numerically; IPv6 is matched by exact (normalized) string.
 * Pure + total: any parse failure is a non-match, never a throw.
 */
export const ipMatchesEntry = (clientIp: string, entry: string): boolean => {
  const ip = normalizeIp(clientIp)
  if (ip === '' || entry === '') {
    return false
  }

  const slashAt = entry.indexOf('/')
  if (slashAt >= 0) {
    const base = entry.slice(0, slashAt)
    const bits = Number(entry.slice(slashAt + 1))
    const ipInt = ipv4ToInt(ip)
    const baseInt = ipv4ToInt(base)
    if (ipInt === null || baseInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
      return false
    }
    if (bits === 0) {
      return true
    }
    const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1) >>> 0)

    return (ipInt & mask) === (baseInt & mask)
  }

  const ipInt = ipv4ToInt(ip)
  if (ipInt !== null) {
    const entryInt = ipv4ToInt(entry)

    return entryInt !== null && entryInt === ipInt
  }

  // IPv6 exact match.
  return normalizeIp(entry) === ip
}

/** Classify an IP against an already-loaded pair of lists (pure). */
export const classifyIp = (clientIp: string, allow: string[], block: string[]): IpAclDecision => {
  if (allow.some((entry) => ipMatchesEntry(clientIp, entry))) {
    return 'allowed'
  }
  if (block.some((entry) => ipMatchesEntry(clientIp, entry))) {
    return 'blocked'
  }

  return 'none'
}

/**
 * Redis-backed store for the two lists with a tiny in-process cache so the hot
 * request path does not SMEMBERS Redis on every call. The cache TTL is short
 * (default 5s) so an admin add/remove takes effect almost immediately; mutations
 * also invalidate the cache synchronously.
 */
export class IpAccessListStore {
  private cache: { allow: string[]; block: string[]; expiresAt: number } | undefined

  constructor(
    private readonly redis: IpAccessListRedis,
    private readonly cacheTtlMs: number = 5000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private keyFor(list: IpAclList): string {
    return list === 'allow' ? IP_ACL_ALLOW_KEY : IP_ACL_BLOCK_KEY
  }

  /** Load both lists, honoring the short cache. Throws on a Redis error. */
  async load(): Promise<{ allow: string[]; block: string[] }> {
    const cached = this.cache
    if (cached && cached.expiresAt > this.now()) {
      return { allow: cached.allow, block: cached.block }
    }
    const [allow, block] = await Promise.all([
      this.redis.smembers(IP_ACL_ALLOW_KEY),
      this.redis.smembers(IP_ACL_BLOCK_KEY),
    ])
    this.cache = { allow, block, expiresAt: this.now() + this.cacheTtlMs }

    return { allow, block }
  }

  /** Classify a client IP; never throws (a Redis error degrades to 'none'). */
  async classify(clientIp: string): Promise<IpAclDecision> {
    const { allow, block } = await this.load()

    return classifyIp(clientIp, allow, block)
  }

  /** Add a VALIDATED entry to a list. Returns the canonical stored value. */
  async add(list: IpAclList, entry: string): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
    const validated = validateIpAclEntry(entry)
    if (!validated.ok) {
      return validated
    }
    await this.redis.sadd(this.keyFor(list), validated.value)
    this.cache = undefined

    return validated
  }

  /** Remove an entry (validated + canonicalized so `1.2.3.4` removes `1.2.3.4`). */
  async remove(list: IpAclList, entry: string): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
    const validated = validateIpAclEntry(entry)
    if (!validated.ok) {
      return validated
    }
    await this.redis.srem(this.keyFor(list), validated.value)
    this.cache = undefined

    return validated
  }

  async list(list: IpAclList): Promise<string[]> {
    const members = await this.redis.smembers(this.keyFor(list))

    return members.slice().sort()
  }
}

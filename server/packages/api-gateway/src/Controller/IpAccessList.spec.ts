import {
  canonicalizeIpv6,
  classifyIp,
  IpAccessListRedis,
  IpAccessListStore,
  ipMatchesEntry,
  ipv4ToInt,
  normalizeIp,
  validateIpAclEntry,
} from './IpAccessList'

describe('IpAccessList', () => {
  describe('normalizeIp', () => {
    it('unwraps IPv4-mapped IPv6 and strips zone ids', () => {
      expect(normalizeIp('::ffff:1.2.3.4')).toBe('1.2.3.4')
      expect(normalizeIp('::1.2.3.4')).toBe('1.2.3.4')
      expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1')
      expect(normalizeIp('1.2.3.4')).toBe('1.2.3.4')
      expect(normalizeIp('')).toBe('')
    })
  })

  describe('canonicalizeIpv6', () => {
    it('collapses an expanded address to the compressed canonical form', () => {
      expect(canonicalizeIpv6('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8::1')
      expect(canonicalizeIpv6('2001:DB8:0:0:0:0:0:1')).toBe('2001:db8::1')
      expect(canonicalizeIpv6('2001:db8::1')).toBe('2001:db8::1')
    })
    it('strips leading zeros from each hextet', () => {
      expect(canonicalizeIpv6('2001:0db8:0000:0000:0000:0000:0000:0010')).toBe('2001:db8::10')
      expect(canonicalizeIpv6('fe80:0000:0000:0000:0000:0000:0000:0001')).toBe('fe80::1')
    })
    it('compresses the longest zero run, leftmost on a tie (RFC 5952)', () => {
      // longest run wins (len-3 over len-2)
      expect(canonicalizeIpv6('2001:0:0:1:0:0:0:1')).toBe('2001:0:0:1::1')
      // equal-length runs -> leftmost compressed, only one "::"
      expect(canonicalizeIpv6('2001:0:0:1:0:0:1:2')).toBe('2001::1:0:0:1:2')
      expect(canonicalizeIpv6('0:0:0:0:0:0:0:0')).toBe('::')
      expect(canonicalizeIpv6('0:0:0:0:0:0:0:1')).toBe('::1')
    })
    it('returns junk lower-cased unchanged (deterministic fallback)', () => {
      expect(canonicalizeIpv6('2001:db8:::1')).toBe('2001:db8:::1')
      expect(canonicalizeIpv6('GHIJ::1')).toBe('ghij::1')
    })
  })

  describe('ipv4ToInt', () => {
    it('parses valid dotted quads and rejects junk', () => {
      expect(ipv4ToInt('0.0.0.0')).toBe(0)
      expect(ipv4ToInt('255.255.255.255')).toBe(0xffffffff)
      expect(ipv4ToInt('1.2.3.4')).toBe(0x01020304)
      expect(ipv4ToInt('256.0.0.1')).toBeNull()
      expect(ipv4ToInt('1.2.3')).toBeNull()
    })
  })

  describe('validateIpAclEntry', () => {
    it('accepts IPv4, IPv4 CIDR and IPv6', () => {
      expect(validateIpAclEntry('1.2.3.4')).toEqual({ ok: true, value: '1.2.3.4' })
      expect(validateIpAclEntry('10.0.0.0/8')).toEqual({ ok: true, value: '10.0.0.0/8' })
      expect(validateIpAclEntry(' 2001:DB8::1 ')).toEqual({ ok: true, value: '2001:db8::1' })
    })
    it('canonicalizes an expanded IPv6 entry to its compressed form on write', () => {
      expect(validateIpAclEntry('2001:0db8:0000:0000:0000:0000:0000:0001')).toEqual({
        ok: true,
        value: '2001:db8::1',
      })
    })
    it('rejects IPv6 CIDR, out-of-range prefixes and injection-shaped input', () => {
      expect(validateIpAclEntry('2001:db8::/64').ok).toBe(false)
      expect(validateIpAclEntry('10.0.0.0/33').ok).toBe(false)
      expect(validateIpAclEntry('1.2.3.4; FLUSHALL').ok).toBe(false)
      expect(validateIpAclEntry('not-an-ip').ok).toBe(false)
      expect(validateIpAclEntry(123 as unknown).ok).toBe(false)
    })
  })

  describe('ipMatchesEntry', () => {
    it('matches exact IPv4 and CIDR ranges', () => {
      expect(ipMatchesEntry('1.2.3.4', '1.2.3.4')).toBe(true)
      expect(ipMatchesEntry('10.1.2.3', '10.0.0.0/8')).toBe(true)
      expect(ipMatchesEntry('11.1.2.3', '10.0.0.0/8')).toBe(false)
      expect(ipMatchesEntry('192.168.1.5', '192.168.1.0/24')).toBe(true)
      expect(ipMatchesEntry('192.168.2.5', '192.168.1.0/24')).toBe(false)
      // /0 matches everything.
      expect(ipMatchesEntry('8.8.8.8', '0.0.0.0/0')).toBe(true)
    })
    it('matches IPv4-mapped IPv6 clients against IPv4 entries', () => {
      expect(ipMatchesEntry('::ffff:10.1.2.3', '10.0.0.0/8')).toBe(true)
    })
    it('matches IPv6 exactly', () => {
      expect(ipMatchesEntry('2001:db8::1', '2001:db8::1')).toBe(true)
      expect(ipMatchesEntry('2001:db8::2', '2001:db8::1')).toBe(false)
    })
    it('matches an expanded stored IPv6 entry against the compressed live address (and vice versa)', () => {
      expect(ipMatchesEntry('2001:db8::1', '2001:0db8:0000:0000:0000:0000:0000:0001')).toBe(true)
      expect(ipMatchesEntry('2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8::1')).toBe(true)
      // leading-zero / uppercase variant of the same address still matches
      expect(ipMatchesEntry('2001:DB8:0:0:0:0:0:1', '2001:db8::1')).toBe(true)
      // a different address must NOT match
      expect(ipMatchesEntry('2001:db8::2', '2001:0db8:0000:0000:0000:0000:0000:0001')).toBe(false)
    })
  })

  describe('classifyIp', () => {
    it('lets allow win over block (admin cannot lock themselves out)', () => {
      expect(classifyIp('1.2.3.4', ['1.2.3.4'], ['0.0.0.0/0'])).toBe('allowed')
      expect(classifyIp('5.6.7.8', [], ['0.0.0.0/0'])).toBe('blocked')
      expect(classifyIp('5.6.7.8', [], [])).toBe('none')
    })
  })

  describe('IpAccessListStore', () => {
    const buildRedis = (): { redis: IpAccessListRedis; sets: Record<string, Set<string>> } => {
      const sets: Record<string, Set<string>> = {}
      const redis: IpAccessListRedis = {
        sadd: jest.fn((key: string, member: string) => {
          sets[key] = sets[key] ?? new Set()
          const had = sets[key].has(member)
          sets[key].add(member)
          return Promise.resolve(had ? 0 : 1)
        }),
        srem: jest.fn((key: string, member: string) => {
          const had = sets[key]?.delete(member)
          return Promise.resolve(had ? 1 : 0)
        }),
        smembers: jest.fn((key: string) => Promise.resolve([...(sets[key] ?? [])])),
      }
      return { redis, sets }
    }

    it('validates before writing and canonicalizes the stored value', async () => {
      const { redis, sets } = buildRedis()
      const store = new IpAccessListStore(redis)
      expect((await store.add('block', 'bad ip')).ok).toBe(false)
      expect(redis.sadd).not.toHaveBeenCalled()

      const added = await store.add('block', ' 10.0.0.0/8 ')
      expect(added).toEqual({ ok: true, value: '10.0.0.0/8' })
      expect([...sets['rl:acl:block']]).toContain('10.0.0.0/8')
    })

    it('classifies via the cache and invalidates it on mutation', async () => {
      const { redis } = buildRedis()
      let clock = 1000
      const store = new IpAccessListStore(redis, 5000, () => clock)
      await store.add('block', '203.0.113.0/24')

      expect(await store.classify('203.0.113.9')).toBe('blocked')
      // second classify within the TTL uses the cache (no extra smembers pair)
      const callsAfterFirst = (redis.smembers as jest.Mock).mock.calls.length
      clock += 1000
      expect(await store.classify('203.0.113.9')).toBe('blocked')
      expect((redis.smembers as jest.Mock).mock.calls.length).toBe(callsAfterFirst)

      // a mutation drops the cache so the next classify re-reads
      await store.add('allow', '203.0.113.9')
      expect(await store.classify('203.0.113.9')).toBe('allowed')
    })

    it('classify never throws — a Redis load error degrades to none (fail-open)', async () => {
      const redis: IpAccessListRedis = {
        sadd: jest.fn(),
        srem: jest.fn(),
        smembers: jest.fn().mockRejectedValue(new Error('redis down')),
      }
      const store = new IpAccessListStore(redis)

      await expect(store.classify('1.2.3.4')).resolves.toBe('none')
    })
  })
})

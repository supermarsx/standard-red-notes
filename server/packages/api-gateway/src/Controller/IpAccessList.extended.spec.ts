import 'reflect-metadata'

import {
  canonicalizeIpv6,
  classifyIp,
  IP_ACL_ALLOW_KEY,
  IP_ACL_BLOCK_KEY,
  IpAccessListStore,
  normalizeIp,
} from './IpAccessList'

describe('IpAccessListStore', () => {
  let redis: { smembers: jest.Mock; sadd: jest.Mock; srem: jest.Mock }
  let now: number
  let store: IpAccessListStore

  const build = (cacheTtlMs = 5000) => new IpAccessListStore(redis as never, cacheTtlMs, () => now)

  beforeEach(() => {
    now = 10_000
    redis = {
      smembers: jest.fn().mockResolvedValue([]),
      sadd: jest.fn().mockResolvedValue(1),
      srem: jest.fn().mockResolvedValue(1),
    }
    store = build()
  })

  describe('load and its cache', () => {
    it('reads both lists from their own Redis keys', async () => {
      redis.smembers.mockImplementation(async (key: string) => (key === IP_ACL_ALLOW_KEY ? ['1.1.1.1'] : ['2.2.2.2']))

      await expect(store.load()).resolves.toEqual({ allow: ['1.1.1.1'], block: ['2.2.2.2'] })
      expect(redis.smembers).toHaveBeenCalledWith(IP_ACL_ALLOW_KEY)
      expect(redis.smembers).toHaveBeenCalledWith(IP_ACL_BLOCK_KEY)
    })

    it('serves a second load from cache without touching Redis again', async () => {
      await store.load()
      redis.smembers.mockClear()

      await store.load()

      expect(redis.smembers).not.toHaveBeenCalled()
    })

    it('reloads from Redis once the cache TTL has elapsed', async () => {
      await store.load()
      redis.smembers.mockClear()

      now += 5000

      await store.load()

      expect(redis.smembers).toHaveBeenCalledTimes(2)
    })

    it('still serves from cache one millisecond before the TTL elapses', async () => {
      await store.load()
      redis.smembers.mockClear()

      now += 4999

      await store.load()

      expect(redis.smembers).not.toHaveBeenCalled()
    })

    it('propagates a Redis failure to the caller', async () => {
      redis.smembers.mockRejectedValue(new Error('redis down'))

      await expect(store.load()).rejects.toThrow('redis down')
    })
  })

  describe('classify', () => {
    it('blocks an IP on the block list', async () => {
      redis.smembers.mockImplementation(async (key: string) => (key === IP_ACL_BLOCK_KEY ? ['9.9.9.9'] : []))

      await expect(store.classify('9.9.9.9')).resolves.toBe('blocked')
    })

    it('allows an IP on the allow list', async () => {
      redis.smembers.mockImplementation(async (key: string) => (key === IP_ACL_ALLOW_KEY ? ['9.9.9.9'] : []))

      await expect(store.classify('9.9.9.9')).resolves.toBe('allowed')
    })

    it('returns none for an IP on neither list', async () => {
      await expect(store.classify('9.9.9.9')).resolves.toBe('none')
    })

    it('fails OPEN rather than blocking when Redis is unavailable', async () => {
      redis.smembers.mockRejectedValue(new Error('redis down'))

      await expect(store.classify('9.9.9.9')).resolves.toBe('none')
    })
  })

  describe('add', () => {
    it('writes the canonical value to the list key and reports it', async () => {
      await expect(store.add('block', '2001:0db8:0000:0000:0000:0000:0000:0001')).resolves.toEqual({
        ok: true,
        value: '2001:db8::1',
      })
      expect(redis.sadd).toHaveBeenCalledWith(IP_ACL_BLOCK_KEY, '2001:db8::1')
    })

    it('writes to the allow key when adding to the allow list', async () => {
      await store.add('allow', '1.2.3.4')

      expect(redis.sadd).toHaveBeenCalledWith(IP_ACL_ALLOW_KEY, '1.2.3.4')
    })

    it('refuses an invalid entry and never writes it', async () => {
      const result = await store.add('block', 'not-an-ip')

      expect(result.ok).toBe(false)
      expect(redis.sadd).not.toHaveBeenCalled()
    })

    it('invalidates the cache so the new entry takes effect immediately', async () => {
      redis.smembers.mockResolvedValue([])
      await expect(store.classify('9.9.9.9')).resolves.toBe('none')

      redis.smembers.mockImplementation(async (key: string) => (key === IP_ACL_BLOCK_KEY ? ['9.9.9.9'] : []))
      await store.add('block', '9.9.9.9')

      await expect(store.classify('9.9.9.9')).resolves.toBe('blocked')
    })

    it('leaves the cache in place when the entry was rejected', async () => {
      await store.load()
      await store.add('block', 'garbage')
      redis.smembers.mockClear()

      await store.load()

      expect(redis.smembers).not.toHaveBeenCalled()
    })
  })

  describe('remove', () => {
    it('removes the canonical value so an expanded spelling removes the stored one', async () => {
      await expect(store.remove('block', '2001:0db8::0001')).resolves.toEqual({ ok: true, value: '2001:db8::1' })
      expect(redis.srem).toHaveBeenCalledWith(IP_ACL_BLOCK_KEY, '2001:db8::1')
    })

    it('refuses an invalid entry and never issues the removal', async () => {
      const result = await store.remove('allow', '999.999.999.999')

      expect(result.ok).toBe(false)
      expect(redis.srem).not.toHaveBeenCalled()
    })

    it('invalidates the cache so the removal takes effect immediately', async () => {
      redis.smembers.mockImplementation(async (key: string) => (key === IP_ACL_BLOCK_KEY ? ['9.9.9.9'] : []))
      await expect(store.classify('9.9.9.9')).resolves.toBe('blocked')

      redis.smembers.mockResolvedValue([])
      await store.remove('block', '9.9.9.9')

      await expect(store.classify('9.9.9.9')).resolves.toBe('none')
    })
  })

  describe('list', () => {
    it('returns the members sorted', async () => {
      redis.smembers.mockResolvedValue(['3.3.3.3', '1.1.1.1', '2.2.2.2'])

      await expect(store.list('allow')).resolves.toEqual(['1.1.1.1', '2.2.2.2', '3.3.3.3'])
    })

    it('reads from the key matching the requested list', async () => {
      await store.list('block')

      expect(redis.smembers).toHaveBeenCalledWith(IP_ACL_BLOCK_KEY)
    })

    it('does not mutate the array Redis returned', async () => {
      const members = ['3.3.3.3', '1.1.1.1']
      redis.smembers.mockResolvedValue(members)

      await store.list('allow')

      expect(members).toEqual(['3.3.3.3', '1.1.1.1'])
    })
  })
})

describe('classifyIp edge cases', () => {
  // classifyIp takes an ALREADY-normalized client IP (its IPv6 comparison is
  // `normalizeIp(entry) === ip`), and every stored entry is validated on write,
  // so junk can only ever arrive as the client IP — and must match nothing.
  it('matches nothing for an unparseable client IP', () => {
    expect(classifyIp('not-an-ip', ['1.2.3.4', '1.2.3.0/24'], ['2001:db8::1'])).toBe('none')
  })

  it('returns none when both lists are empty', () => {
    expect(classifyIp('1.2.3.4', [], [])).toBe('none')
  })

  it('lets an allow entry win over a block entry that also matches', () => {
    expect(classifyIp('1.2.3.4', ['1.2.3.4'], ['1.2.3.0/24'])).toBe('allowed')
  })
})

describe('canonicalizeIpv6 malformed input', () => {
  it('returns the input lower-cased when it contains more than one "::"', () => {
    expect(canonicalizeIpv6('2001::db8::1')).toBe('2001::db8::1')
  })

  it('returns the input lower-cased when it has too many groups around "::"', () => {
    expect(canonicalizeIpv6('1:2:3:4:5:6:7:8:9::10')).toBe('1:2:3:4:5:6:7:8:9::10')
  })

  it('returns the input lower-cased when an uncompressed address has the wrong group count', () => {
    expect(canonicalizeIpv6('1:2:3')).toBe('1:2:3')
  })
})

describe('normalizeIp edge cases', () => {
  it('returns an empty string for a non-string input', () => {
    expect(normalizeIp(undefined as never)).toBe('')
    expect(normalizeIp(42 as never)).toBe('')
  })

  it('returns an empty string for blank input', () => {
    expect(normalizeIp('')).toBe('')
    expect(normalizeIp('   ')).toBe('')
  })
})

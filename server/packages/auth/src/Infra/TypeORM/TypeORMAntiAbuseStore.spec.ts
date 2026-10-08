import { CacheEntry, CacheEntryRepositoryInterface } from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'

import { TypeORMAntiAbuseStore } from './TypeORMAntiAbuseStore'

let now = Date.parse('2026-10-08T12:00:00.000Z')

/**
 * Stand-in for the cache-table repository, faithful to the behaviours of the real
 * one this store depends on -- and to the one that would otherwise bite it.
 *
 *   - `findUnexpiredOneByKey` filters on `expires_at > now` (in SQL in the real
 *     one), which is why a persisted list needs a horizon at all and why a NULL
 *     one would read as already gone.
 *   - `save` INSERTS; it does not upsert. A Map-backed fake would overwrite and
 *     would therefore pass against a store that never deletes.
 *   - that read ends in an unordered `getOne()`, so with several rows under one
 *     key the row returned is arbitrary. This fake returns the OLDEST, which is
 *     the row that hands back a list an admin has already changed.
 */
class AppendOnlyCacheEntryRepository implements CacheEntryRepositoryInterface {
  readonly rows: CacheEntry[] = []
  removeCalls = 0

  async save(cacheEntry: CacheEntry): Promise<void> {
    this.rows.push(cacheEntry)
  }

  async findUnexpiredOneByKey(key: string): Promise<CacheEntry | null> {
    const unexpired = this.rows.filter(
      (row) => row.props.key === key && (row.props.expiresAt === null || row.props.expiresAt.getTime() > now),
    )

    return unexpired.length > 0 ? unexpired[0] : null
  }

  async removeByKey(key: string): Promise<void> {
    this.removeCalls += 1
    for (let index = this.rows.length - 1; index >= 0; index--) {
      if (this.rows[index].props.key === key) {
        this.rows.splice(index, 1)
      }
    }
  }

  rowsFor(key: string): CacheEntry[] {
    return this.rows.filter((row) => row.props.key === key)
  }
}

const A_CENTURY_MS = 100 * 365 * 24 * 60 * 60 * 1000

describe('TypeORMAntiAbuseStore', () => {
  const ALLOW = 'rl:acl:allow'
  const BLOCK = 'rl:acl:block'
  const TIERS = 'rl:metrics:tiers'
  const RECENT = 'rl:metrics:recent'

  let cacheEntryRepository: AppendOnlyCacheEntryRepository
  let timer: TimerInterface
  let store: TypeORMAntiAbuseStore

  beforeEach(() => {
    now = Date.parse('2026-10-08T12:00:00.000Z')
    cacheEntryRepository = new AppendOnlyCacheEntryRepository()
    timer = {
      getUTCDateNSecondsAhead: jest.fn().mockImplementation((seconds: number) => new Date(now + seconds * 1000)),
    } as unknown as jest.Mocked<TimerInterface>
    store = new TypeORMAntiAbuseStore(cacheEntryRepository, timer)
  })

  describe('sets (the two IP access lists)', () => {
    it('adds, lists and removes members, reporting 1/0 the way SADD and SREM do', async () => {
      await expect(store.sadd(BLOCK, '203.0.113.9')).resolves.toEqual(1)
      await expect(store.sadd(BLOCK, '198.51.100.0/24')).resolves.toEqual(1)
      await expect(store.sadd(BLOCK, '203.0.113.9')).resolves.toEqual(0)

      await expect(store.smembers(BLOCK)).resolves.toEqual(['203.0.113.9', '198.51.100.0/24'])

      await expect(store.srem(BLOCK, '203.0.113.9')).resolves.toEqual(1)
      await expect(store.srem(BLOCK, '203.0.113.9')).resolves.toEqual(0)
      await expect(store.smembers(BLOCK)).resolves.toEqual(['198.51.100.0/24'])
    })

    it('returns an empty list for a key that was never written', async () => {
      await expect(store.smembers(ALLOW)).resolves.toEqual([])
    })

    it('keeps the two lists apart, so allowlisting an address does not blocklist it', async () => {
      await store.sadd(ALLOW, '10.0.0.1')
      await store.sadd(BLOCK, '203.0.113.9')

      await expect(store.smembers(ALLOW)).resolves.toEqual(['10.0.0.1'])
      await expect(store.smembers(BLOCK)).resolves.toEqual(['203.0.113.9'])
    })

    it('drops the key when the last member goes, exactly like Redis', async () => {
      await store.sadd(BLOCK, '203.0.113.9')
      await store.srem(BLOCK, '203.0.113.9')

      expect(cacheEntryRepository.rowsFor(BLOCK)).toHaveLength(0)
      await expect(store.smembers(BLOCK)).resolves.toEqual([])
    })

    it('PERSISTS: a list nothing expired keeps a horizon far enough out to be "never", because a NULL would read as gone', async () => {
      await store.sadd(BLOCK, '203.0.113.9')

      const [row] = cacheEntryRepository.rowsFor(BLOCK)
      expect(row.props.expiresAt).not.toBeNull()
      expect((row.props.expiresAt as Date).getTime()).toBeGreaterThan(now + A_CENTURY_MS - 1000)

      now += 10 * 365 * 24 * 60 * 60 * 1000
      await expect(store.smembers(BLOCK)).resolves.toEqual(['203.0.113.9'])
    })

    it('DELETES BEFORE IT WRITES, so an address an admin just blocked cannot read back unblocked', async () => {
      await store.sadd(BLOCK, '203.0.113.9')
      await store.sadd(BLOCK, '203.0.113.10')
      await store.sadd(BLOCK, '203.0.113.11')

      expect(cacheEntryRepository.rowsFor(BLOCK)).toHaveLength(1)
      await expect(store.smembers(BLOCK)).resolves.toEqual(['203.0.113.9', '203.0.113.10', '203.0.113.11'])
    })

    it('SERIALIZES concurrent adds, so two admins adding at once do not lose one entry', async () => {
      await Promise.all([
        store.sadd(BLOCK, '203.0.113.1'),
        store.sadd(BLOCK, '203.0.113.2'),
        store.sadd(BLOCK, '203.0.113.3'),
        store.sadd(BLOCK, '203.0.113.4'),
      ])

      await expect(store.smembers(BLOCK)).resolves.toHaveLength(4)
      expect(cacheEntryRepository.rowsFor(BLOCK)).toHaveLength(1)
    })

    it('does not queue the allow list behind the block list', async () => {
      const [allowed, blocked] = await Promise.all([store.sadd(ALLOW, '10.0.0.1'), store.sadd(BLOCK, '203.0.113.9')])

      expect([allowed, blocked]).toEqual([1, 1])
    })
  })

  describe('hashes (the tier and block hit counters)', () => {
    it('increments per field and reads the whole hash back as strings', async () => {
      await expect(store.hincrby(TIERS, 'auth-login', 1)).resolves.toEqual(1)
      await expect(store.hincrby(TIERS, 'auth-login', 1)).resolves.toEqual(2)
      await expect(store.hincrby(TIERS, 'auth-sensitive', 3)).resolves.toEqual(3)

      await expect(store.hgetall(TIERS)).resolves.toEqual({ 'auth-login': '2', 'auth-sensitive': '3' })
    })

    it('returns an empty object for a key that was never written', async () => {
      await expect(store.hgetall(TIERS)).resolves.toEqual({})
    })

    it('DELETES BEFORE IT WRITES, so a counter cannot read back behind', async () => {
      await store.hincrby(TIERS, 'auth-login', 1)
      await store.hincrby(TIERS, 'auth-login', 1)
      await store.hincrby(TIERS, 'auth-login', 1)

      expect(cacheEntryRepository.rowsFor(TIERS)).toHaveLength(1)
      await expect(store.hgetall(TIERS)).resolves.toEqual({ 'auth-login': '3' })
    })

    it('SERIALIZES concurrent increments, so simultaneous refusals are all counted', async () => {
      await Promise.all([
        store.hincrby(TIERS, 'auth-login', 1),
        store.hincrby(TIERS, 'auth-login', 1),
        store.hincrby(TIERS, 'auth-login', 1),
      ])

      await expect(store.hgetall(TIERS)).resolves.toEqual({ 'auth-login': '3' })
    })

    it('treats a junk field value as zero rather than propagating NaN into the panel', async () => {
      await store.hincrby(TIERS, 'auth-login', 1)
      const [row] = cacheEntryRepository.rowsFor(TIERS)
      row.props.value = JSON.stringify({ t: 'hash', f: { 'auth-login': 'junk' } })

      await expect(store.hincrby(TIERS, 'auth-login', 1)).resolves.toEqual(1)
    })
  })

  describe('lists (the recent-throttle ring)', () => {
    it('pushes newest-first, reports the new length and reads a range back', async () => {
      await expect(store.lpush(RECENT, 'one')).resolves.toEqual(1)
      await expect(store.lpush(RECENT, 'two')).resolves.toEqual(2)
      await expect(store.lpush(RECENT, 'three')).resolves.toEqual(3)

      await expect(store.lrange(RECENT, 0, 199)).resolves.toEqual(['three', 'two', 'one'])
      await expect(store.lrange(RECENT, 0, 1)).resolves.toEqual(['three', 'two'])
    })

    it('CAPS the ring with ltrim, so the row cannot grow without bound', async () => {
      for (let index = 0; index < 6; index++) {
        await store.lpush(RECENT, `event-${index}`)
      }
      await store.ltrim(RECENT, 0, 2)

      await expect(store.lrange(RECENT, 0, 199)).resolves.toEqual(['event-5', 'event-4', 'event-3'])
    })

    it('honours negative indices the way Redis does', async () => {
      await store.lpush(RECENT, 'one')
      await store.lpush(RECENT, 'two')
      await store.lpush(RECENT, 'three')

      await expect(store.lrange(RECENT, -2, -1)).resolves.toEqual(['two', 'one'])
      await expect(store.lrange(RECENT, 0, -1)).resolves.toEqual(['three', 'two', 'one'])
    })

    it('returns an empty range for a key that was never written, and trimming it is a no-op', async () => {
      await expect(store.lrange(RECENT, 0, 199)).resolves.toEqual([])
      await expect(store.ltrim(RECENT, 0, 199)).resolves.toBeUndefined()
      expect(cacheEntryRepository.rows).toHaveLength(0)
    })

    it('drops the key when a trim empties the list, exactly like Redis', async () => {
      await store.lpush(RECENT, 'one')
      await store.ltrim(RECENT, 5, 10)

      expect(cacheEntryRepository.rowsFor(RECENT)).toHaveLength(0)
    })

    it('DELETES BEFORE IT WRITES, so the ring cannot read back short', async () => {
      await store.lpush(RECENT, 'one')
      await store.lpush(RECENT, 'two')

      expect(cacheEntryRepository.rowsFor(RECENT)).toHaveLength(1)
      await expect(store.lrange(RECENT, 0, 199)).resolves.toEqual(['two', 'one'])
    })

    it('SERIALIZES concurrent pushes, so simultaneous refusals all land in the ring', async () => {
      await Promise.all([store.lpush(RECENT, 'a'), store.lpush(RECENT, 'b'), store.lpush(RECENT, 'c')])

      await expect(store.lrange(RECENT, 0, 199)).resolves.toHaveLength(3)
    })
  })

  describe('expire', () => {
    it('sets the horizon and reports 1, and the key is gone once it passes', async () => {
      await store.hincrby(TIERS, 'auth-login', 1)

      await expect(store.expire(TIERS, 60)).resolves.toEqual(1)
      expect(cacheEntryRepository.rowsFor(TIERS)[0].props.expiresAt).toEqual(new Date(now + 60_000))

      now += 61_000
      await expect(store.hgetall(TIERS)).resolves.toEqual({})
    })

    it('reports 0 for a missing key and writes nothing, exactly like Redis', async () => {
      await expect(store.expire(TIERS, 60)).resolves.toEqual(0)
      expect(cacheEntryRepository.rows).toHaveLength(0)
    })

    it('keeps the value it was holding', async () => {
      await store.lpush(RECENT, 'one')
      await store.expire(RECENT, 60)

      await expect(store.lrange(RECENT, 0, 199)).resolves.toEqual(['one'])
    })

    it('deletes the key for a non-positive expiry, exactly like Redis', async () => {
      await store.hincrby(TIERS, 'auth-login', 1)

      await expect(store.expire(TIERS, 0)).resolves.toEqual(1)
      expect(cacheEntryRepository.rowsFor(TIERS)).toHaveLength(0)
    })

    it('CARRIES AN EXISTING HORIZON FORWARD across a mutation, because HINCRBY and LPUSH never touch a TTL', async () => {
      await store.hincrby(TIERS, 'auth-login', 1)
      await store.expire(TIERS, 600)
      const armed = cacheEntryRepository.rowsFor(TIERS)[0].props.expiresAt

      now += 100_000
      await store.hincrby(TIERS, 'auth-login', 1)

      expect(cacheEntryRepository.rowsFor(TIERS)[0].props.expiresAt).toEqual(armed)
    })

    it('carries a list horizon forward across a push and a trim too', async () => {
      await store.lpush(RECENT, 'one')
      await store.expire(RECENT, 600)
      const armed = cacheEntryRepository.rowsFor(RECENT)[0].props.expiresAt

      now += 100_000
      await store.lpush(RECENT, 'two')
      await store.ltrim(RECENT, 0, 199)

      expect(cacheEntryRepository.rowsFor(RECENT)[0].props.expiresAt).toEqual(armed)
    })

    it('carries a set horizon forward across an add and a remove', async () => {
      await store.sadd(BLOCK, '203.0.113.9')
      await store.expire(BLOCK, 600)
      const armed = cacheEntryRepository.rowsFor(BLOCK)[0].props.expiresAt

      now += 100_000
      await store.sadd(BLOCK, '203.0.113.10')
      await store.srem(BLOCK, '203.0.113.9')

      expect(cacheEntryRepository.rowsFor(BLOCK)[0].props.expiresAt).toEqual(armed)
    })
  })

  describe('a row of the wrong shape', () => {
    const plant = async (key: string, value: string): Promise<void> => {
      await cacheEntryRepository.save(
        CacheEntry.create({ key, value, expiresAt: new Date(now + 600_000) }).getValue(),
      )
    }

    it('degrades to empty rather than coercing junk into a list of blocked addresses', async () => {
      await plant(BLOCK, 'not json at all')

      await expect(store.smembers(BLOCK)).resolves.toEqual([])
    })

    it('degrades to empty when the envelope is the wrong kind', async () => {
      await plant(BLOCK, JSON.stringify({ t: 'hash', f: { a: '1' } }))
      await plant(TIERS, JSON.stringify({ t: 'set', m: ['x'] }))
      await plant(RECENT, JSON.stringify({ t: 'hash', f: {} }))

      await expect(store.smembers(BLOCK)).resolves.toEqual([])
      await expect(store.hgetall(TIERS)).resolves.toEqual({})
      await expect(store.lrange(RECENT, 0, 199)).resolves.toEqual([])
    })

    it('degrades to empty when a member is not a string', async () => {
      await plant(BLOCK, JSON.stringify({ t: 'set', m: ['ok', 7] }))

      await expect(store.smembers(BLOCK)).resolves.toEqual([])
    })

    it('degrades to empty when a hash field is not a string', async () => {
      await plant(TIERS, JSON.stringify({ t: 'hash', f: { 'auth-login': 3 } }))

      await expect(store.hgetall(TIERS)).resolves.toEqual({})
    })

    it('REPLACES a corrupt row rather than inheriting its shape, so an admin can still add an entry', async () => {
      await plant(BLOCK, 'not json at all')

      await expect(store.sadd(BLOCK, '203.0.113.9')).resolves.toEqual(1)
      await expect(store.smembers(BLOCK)).resolves.toEqual(['203.0.113.9'])
      expect(cacheEntryRepository.rowsFor(BLOCK)).toHaveLength(1)
    })
  })
})

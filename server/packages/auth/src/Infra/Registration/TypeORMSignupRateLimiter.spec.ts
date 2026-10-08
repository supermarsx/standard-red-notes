import { CacheEntry, CacheEntryRepositoryInterface } from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'

import { TypeORMSignupRateLimiter } from './TypeORMSignupRateLimiter'

let now = Date.parse('2026-10-08T12:00:00.000Z')

/**
 * Stand-in for the cache-table repository, faithful to the three behaviours of
 * the real one this limiter depends on -- and to the one that would otherwise
 * bite it.
 *
 *   - `findUnexpiredOneByKey` filters on `expires_at > now` (in SQL in the real
 *     one). Without this the window tests below would be vacuous.
 *   - `save` INSERTS; it does not upsert. `CacheEntry.create` mints a fresh
 *     UniqueEntityId per call and `TypeORMCacheEntryRepository.save` hands that
 *     straight to `ormRepository.save`, so a second write under one key leaves a
 *     SECOND row. A Map-backed fake would silently overwrite and would therefore
 *     pass against a limiter that never deletes.
 *   - that read ends in an unordered `getOne()`, so with two unexpired rows under
 *     one key the row returned is arbitrary. This fake returns the OLDEST, which
 *     is the case that hands an address an unbounded allowance.
 */
class AppendOnlyCacheEntryRepository implements CacheEntryRepositoryInterface {
  readonly rows: CacheEntry[] = []
  saveCalls = 0
  removeCalls = 0
  failSave = false
  failRead = false

  async save(cacheEntry: CacheEntry): Promise<void> {
    this.saveCalls += 1
    if (this.failSave) {
      throw new Error('insert failed')
    }
    this.rows.push(cacheEntry)
  }

  async findUnexpiredOneByKey(key: string): Promise<CacheEntry | null> {
    if (this.failRead) {
      throw new Error('select failed')
    }
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

describe('TypeORMSignupRateLimiter', () => {
  const KEY = 'signup:ip:203.0.113.7'
  const CACHE_KEY = `signup-limit:${KEY}`
  const WINDOW = 3600

  let cacheEntryRepository: AppendOnlyCacheEntryRepository
  let timer: TimerInterface
  let limiter: TypeORMSignupRateLimiter

  beforeEach(() => {
    now = Date.parse('2026-10-08T12:00:00.000Z')
    cacheEntryRepository = new AppendOnlyCacheEntryRepository()
    timer = {
      getUTCDateNSecondsAhead: jest.fn().mockImplementation((seconds: number) => new Date(now + seconds * 1000)),
    } as unknown as jest.Mocked<TimerInterface>
    limiter = new TypeORMSignupRateLimiter(cacheEntryRepository, timer)
  })

  it('counts up from one, so the caller can compare against the cap', async () => {
    await expect(limiter.incrementAndCount(KEY, WINDOW)).resolves.toEqual(1)
    await expect(limiter.incrementAndCount(KEY, WINDOW)).resolves.toEqual(2)
    await expect(limiter.incrementAndCount(KEY, WINDOW)).resolves.toEqual(3)
  })

  it('counts each key separately', async () => {
    await limiter.incrementAndCount(KEY, WINDOW)
    await limiter.incrementAndCount(KEY, WINDOW)

    await expect(limiter.incrementAndCount('signup:dev:device-a', WINDOW)).resolves.toEqual(1)
  })

  it('namespaces the row so it cannot collide with another user of the cache table', async () => {
    await limiter.incrementAndCount(KEY, WINDOW)

    expect(cacheEntryRepository.rows.map((row) => row.props.key)).toEqual([CACHE_KEY])
  })

  it('writes the count and its horizon in ONE save, so no row can exist without an expiry', async () => {
    await limiter.incrementAndCount(KEY, WINDOW)

    expect(cacheEntryRepository.saveCalls).toEqual(1)
    expect(cacheEntryRepository.rowsFor(CACHE_KEY)).toHaveLength(1)
    expect(cacheEntryRepository.rowsFor(CACHE_KEY)[0].props.expiresAt).toEqual(new Date(now + WINDOW * 1000))
  })

  it('ARMS THE HORIZON ONLY ON THE FIRST INCREMENT, so a client that keeps trying still gets a fresh window', async () => {
    await limiter.incrementAndCount(KEY, WINDOW)
    const armed = cacheEntryRepository.rowsFor(CACHE_KEY)[0].props.expiresAt

    now += 1_800_000
    await limiter.incrementAndCount(KEY, WINDOW)
    now += 1_000_000
    await limiter.incrementAndCount(KEY, WINDOW)

    expect(cacheEntryRepository.rowsFor(CACHE_KEY)[0].props.expiresAt).toEqual(armed)
  })

  it('opens a fresh window once the horizon passes', async () => {
    await limiter.incrementAndCount(KEY, WINDOW)
    await limiter.incrementAndCount(KEY, WINDOW)
    await expect(limiter.incrementAndCount(KEY, WINDOW)).resolves.toEqual(3)

    now += (WINDOW + 1) * 1000

    await expect(limiter.incrementAndCount(KEY, WINDOW)).resolves.toEqual(1)
    expect(cacheEntryRepository.rowsFor(CACHE_KEY)[0].props.expiresAt).toEqual(new Date(now + WINDOW * 1000))
  })

  it('DELETES BEFORE IT WRITES, so one key never accumulates rows and the count cannot read back stale', async () => {
    await limiter.incrementAndCount(KEY, WINDOW)
    await limiter.incrementAndCount(KEY, WINDOW)
    await limiter.incrementAndCount(KEY, WINDOW)

    expect(cacheEntryRepository.rowsFor(CACHE_KEY)).toHaveLength(1)
    expect(cacheEntryRepository.rowsFor(CACHE_KEY)[0].props.value).toEqual('3')
    expect(cacheEntryRepository.removeCalls).toEqual(3)
  })

  it('SERIALIZES concurrent increments for one key, so a parallel run spends its real allowance', async () => {
    const counts = await Promise.all([
      limiter.incrementAndCount(KEY, WINDOW),
      limiter.incrementAndCount(KEY, WINDOW),
      limiter.incrementAndCount(KEY, WINDOW),
      limiter.incrementAndCount(KEY, WINDOW),
    ])

    expect(counts.slice().sort()).toEqual([1, 2, 3, 4])
    expect(cacheEntryRepository.rowsFor(CACHE_KEY)).toHaveLength(1)
  })

  it('does not queue one key behind another', async () => {
    const [first, second] = await Promise.all([
      limiter.incrementAndCount(KEY, WINDOW),
      limiter.incrementAndCount('signup:dev:device-b', WINDOW),
    ])

    expect([first, second]).toEqual([1, 1])
  })

  it('REFUSES TO WRITE A ROW IT COULD NOT EXPIRE, failing open rather than locking the address out forever', async () => {
    await expect(limiter.incrementAndCount(KEY, 0)).resolves.toBeNull()
    await expect(limiter.incrementAndCount(KEY, -5)).resolves.toBeNull()
    await expect(limiter.incrementAndCount(KEY, Number.NaN)).resolves.toBeNull()
    await expect(limiter.incrementAndCount(KEY, Number.POSITIVE_INFINITY)).resolves.toBeNull()

    expect(cacheEntryRepository.rows).toHaveLength(0)
  })

  it('fails open on an empty key', async () => {
    await expect(limiter.incrementAndCount('', WINDOW)).resolves.toBeNull()
    expect(cacheEntryRepository.rows).toHaveLength(0)
  })

  it('FAILS OPEN on a read error, so a database blip never blocks registration', async () => {
    cacheEntryRepository.failRead = true

    await expect(limiter.incrementAndCount(KEY, WINDOW)).resolves.toBeNull()
  })

  it('FAILS OPEN on a write error', async () => {
    cacheEntryRepository.failSave = true

    await expect(limiter.incrementAndCount(KEY, WINDOW)).resolves.toBeNull()
  })

  it('a failed increment does not poison the next one for the same key', async () => {
    cacheEntryRepository.failSave = true
    await expect(limiter.incrementAndCount(KEY, WINDOW)).resolves.toBeNull()

    cacheEntryRepository.failSave = false
    await expect(limiter.incrementAndCount(KEY, WINDOW)).resolves.toEqual(1)
  })

  it('treats a row it did not write as no count, so junk neither refuses nor exempts the address', async () => {
    for (const junk of ['not-a-number', '-4', '']) {
      cacheEntryRepository.rows.length = 0
      await cacheEntryRepository.save(
        CacheEntry.create({ key: CACHE_KEY, value: junk, expiresAt: new Date(now + 60_000) }).getValue(),
      )

      await expect(limiter.incrementAndCount(KEY, WINDOW)).resolves.toEqual(1)
    }
  })

  it('keeps the horizon of a row whose count is junk rather than re-arming it', async () => {
    await cacheEntryRepository.save(
      CacheEntry.create({ key: CACHE_KEY, value: 'junk', expiresAt: new Date(now + 60_000) }).getValue(),
    )

    await limiter.incrementAndCount(KEY, WINDOW)

    expect(cacheEntryRepository.rowsFor(CACHE_KEY)[0].props.expiresAt).toEqual(new Date(now + 60_000))
  })

  it('arms a horizon for a row that somehow has none, rather than carrying the absence forward', async () => {
    await cacheEntryRepository.save(CacheEntry.create({ key: CACHE_KEY, value: '5', expiresAt: null }).getValue())

    await expect(limiter.incrementAndCount(KEY, WINDOW)).resolves.toEqual(6)
    expect(cacheEntryRepository.rowsFor(CACHE_KEY)[0].props.expiresAt).toEqual(new Date(now + WINDOW * 1000))
  })
})

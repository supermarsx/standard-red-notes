import { CacheEntry, CacheEntryRepositoryInterface, Uuid } from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'

import { TypeORMSessionTokensCooldownRepository } from './TypeORMSessionTokensCooldownRepository'

let now = Date.parse('2026-10-05T12:00:00.000Z')

/**
 * Stand-in for the cache-table repository, faithful to the two behaviours of
 * the real one that this store depends on -- and to the one that would
 * otherwise bite it.
 *
 *   - `findUnexpiredOneByKey` filters on `expires_at > now` (in the real one,
 *     in SQL). Without this the expiry tests below would be vacuous.
 *   - `save` INSERTS; it does not upsert. `CacheEntry.create` mints a fresh
 *     UniqueEntityId per call and `TypeORMCacheEntryRepository.save` hands that
 *     straight to `ormRepository.save`, so a second write under the same key
 *     leaves a SECOND row. A Map-backed fake would silently overwrite and would
 *     therefore pass even against a store that never deletes.
 *   - `findUnexpiredOneByKey` ends in an unordered `getOne()`, so with two
 *     unexpired rows under one key the row it returns is arbitrary. The fake
 *     returns the OLDEST, which is the case that actually loses a 498.
 */
class AppendOnlyCacheEntryRepository implements CacheEntryRepositoryInterface {
  readonly rows: CacheEntry[] = []

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

describe('TypeORMSessionTokensCooldownRepository', () => {
  const SESSION = '0f1e2d3c-4b5a-4968-8776-65544332211f'
  const OTHER_SESSION = '11111111-2222-4333-8444-555555555555'
  const KEY = `cooldown:session-tokens:${SESSION}`

  const ACCESS = 'a'.repeat(64)
  const REFRESH = 'b'.repeat(64)
  const NEXT_ACCESS = 'c'.repeat(64)
  const NEXT_REFRESH = 'd'.repeat(64)

  let cacheEntryRepository: AppendOnlyCacheEntryRepository
  let timer: TimerInterface
  let repository: TypeORMSessionTokensCooldownRepository

  const uuid = (value: string): Uuid => Uuid.create(value).getValue()

  beforeEach(() => {
    now = Date.parse('2026-10-05T12:00:00.000Z')
    cacheEntryRepository = new AppendOnlyCacheEntryRepository()

    timer = {
      getUTCDateNSecondsAhead: jest.fn().mockImplementation((seconds: number) => new Date(now + seconds * 1000)),
    } as unknown as jest.Mocked<TimerInterface>

    repository = new TypeORMSessionTokensCooldownRepository(cacheEntryRepository, timer)
  })

  const setCooldown = async (
    hashedAccessToken = ACCESS,
    hashedRefreshToken = REFRESH,
    cooldownPeriodInSeconds = 120,
    sessionUuid = SESSION,
  ): Promise<void> =>
    repository.setCooldown({
      sessionUuid: uuid(sessionUuid),
      hashedAccessToken,
      hashedRefreshToken,
      cooldownPeriodInSeconds,
    })

  describe('round trip', () => {
    it('hands back the pair that was put into cooldown', async () => {
      await setCooldown()

      expect(await repository.getHashedTokens(uuid(SESSION))).toEqual({
        hashedAccessToken: ACCESS,
        hashedRefreshToken: REFRESH,
      })
    })

    it('reads as "no cooldown" when none was ever set', async () => {
      expect(await repository.getHashedTokens(uuid(SESSION))).toBeNull()
    })

    it('scopes the entry to its own session', async () => {
      await setCooldown()

      expect(await repository.getHashedTokens(uuid(OTHER_SESSION))).toBeNull()
    })

    it('stores the wire format the Redis store uses, under the same key shape', async () => {
      await setCooldown()

      const [row] = cacheEntryRepository.rowsFor(KEY)
      expect(row.props.key).toEqual(KEY)
      expect(row.props.value).toEqual(`1:${ACCESS}:${REFRESH}`)
    })
  })

  describe('expiry', () => {
    it('still honours the cooldown one second before the horizon', async () => {
      await setCooldown(ACCESS, REFRESH, 120)

      now += 119 * 1000

      expect(await repository.getHashedTokens(uuid(SESSION))).toEqual({
        hashedAccessToken: ACCESS,
        hashedRefreshToken: REFRESH,
      })
    })

    it('EXPIRES the cooldown one second after the horizon', async () => {
      await setCooldown(ACCESS, REFRESH, 120)

      now += 121 * 1000

      expect(await repository.getHashedTokens(uuid(SESSION))).toBeNull()
    })

    it('sets the horizon from the requested cooldown period, not a fixed default', async () => {
      await setCooldown(ACCESS, REFRESH, 30)

      const [row] = cacheEntryRepository.rowsFor(KEY)
      expect(row.props.expiresAt).toEqual(new Date(now + 30 * 1000))

      now += 31 * 1000
      expect(await repository.getHashedTokens(uuid(SESSION))).toBeNull()
    })

    it('never stores a row that outlives its horizon', async () => {
      await setCooldown(ACCESS, REFRESH, 120)

      const [row] = cacheEntryRepository.rowsFor(KEY)
      expect(row.props.expiresAt).not.toBeNull()
    })
  })

  describe('supersession', () => {
    it('replaces the previous pair so a twice-rotated credential stops matching', async () => {
      await setCooldown(ACCESS, REFRESH, 120)
      await setCooldown(NEXT_ACCESS, NEXT_REFRESH, 120)

      expect(await repository.getHashedTokens(uuid(SESSION))).toEqual({
        hashedAccessToken: NEXT_ACCESS,
        hashedRefreshToken: NEXT_REFRESH,
      })
    })

    it('keeps exactly one row per session however often the session refreshes', async () => {
      for (let refresh = 0; refresh < 25; refresh++) {
        await setCooldown(ACCESS, REFRESH, 120)
      }

      expect(cacheEntryRepository.rowsFor(KEY)).toHaveLength(1)
      expect(cacheEntryRepository.rows).toHaveLength(1)
    })
  })

  describe('unreadable rows', () => {
    it('reads an unknown format version as "no cooldown"', async () => {
      await cacheEntryRepository.save(
        CacheEntry.create({
          key: KEY,
          value: `2:${ACCESS}:${REFRESH}`,
          expiresAt: new Date(now + 120 * 1000),
        }).getValue(),
      )

      expect(await repository.getHashedTokens(uuid(SESSION))).toBeNull()
    })

    it('reads a truncated row as "no cooldown" instead of throwing', async () => {
      await cacheEntryRepository.save(
        CacheEntry.create({
          key: KEY,
          value: `1:${ACCESS}`,
          expiresAt: new Date(now + 120 * 1000),
        }).getValue(),
      )

      expect(await repository.getHashedTokens(uuid(SESSION))).toBeNull()
    })
  })
})

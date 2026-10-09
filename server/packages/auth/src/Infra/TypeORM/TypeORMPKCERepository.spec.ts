import { CacheEntry, CacheEntryRepositoryInterface } from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'
import { Logger } from 'winston'

import { TypeORMPKCERepository } from './TypeORMPKCERepository'

let now = Date.parse('2026-10-09T12:00:00.000Z')

/**
 * Stand-in for the cache-table repository, faithful to the three behaviours of
 * the real one that decide whether this store's single-use guarantee holds.
 *
 *   - `save` INSERTS; it does not upsert. `CacheEntry.create` mints a fresh
 *     UniqueEntityId per call, `TypeORMCacheEntryRepository.save` hands that
 *     straight to `ormRepository.save`, and `auth_cache_entries` has no unique
 *     index on `key`, so a second write under one key leaves a SECOND row. A
 *     Map-backed fake would overwrite instead, and the duplicate-row test below
 *     would then pass against a repository that only ever removed one row.
 *   - `findUnexpiredOneByKey` filters `expires_at > now` IN SQL. Without that
 *     the expiry test would be vacuous.
 *   - `removeByKey` deletes BY KEY, i.e. every row carrying it.
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
    this.removeCalls++
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

describe('TypeORMPKCERepository', () => {
  const CHALLENGE = 'cmlzIG11c3Qtbm90LXJlcGxheQ'
  const KEY = `pkce:${CHALLENGE}`

  let cacheEntryRepository: AppendOnlyCacheEntryRepository
  let logger: Logger
  let timer: TimerInterface

  const secondsAhead = (seconds: number): Date => new Date(now + seconds * 1000)

  const createRepository = (): TypeORMPKCERepository => new TypeORMPKCERepository(cacheEntryRepository, logger, timer)

  beforeEach(() => {
    now = Date.parse('2026-10-09T12:00:00.000Z')

    cacheEntryRepository = new AppendOnlyCacheEntryRepository()

    logger = {
      debug: jest.fn(),
    } as unknown as jest.Mocked<Logger>

    timer = {
      getUTCDateNSecondsAhead: jest.fn().mockImplementation((seconds: number) => secondsAhead(seconds)),
    } as unknown as jest.Mocked<TimerInterface>
  })

  describe('storeCodeChallenge', () => {
    it('writes the challenge under a prefixed key with a one-hour horizon', async () => {
      await createRepository().storeCodeChallenge(CHALLENGE)

      const rows = cacheEntryRepository.rowsFor(KEY)
      expect(rows).toHaveLength(1)
      expect(rows[0].props.value).toEqual(CHALLENGE)
      expect(rows[0].props.expiresAt).toEqual(secondsAhead(3600))
      expect(timer.getUTCDateNSecondsAhead).toHaveBeenCalledWith(3600)
    })

    it('does not collide with another challenge', async () => {
      const repository = createRepository()

      await repository.storeCodeChallenge(CHALLENGE)
      await repository.storeCodeChallenge('another-challenge')

      expect(cacheEntryRepository.rowsFor(KEY)).toHaveLength(1)
      expect(cacheEntryRepository.rowsFor('pkce:another-challenge')).toHaveLength(1)
    })
  })

  describe('removeCodeChallenge', () => {
    it('reports true for a first use and removes the row', async () => {
      const repository = createRepository()
      await repository.storeCodeChallenge(CHALLENGE)

      await expect(repository.removeCodeChallenge(CHALLENGE)).resolves.toBe(true)
      expect(cacheEntryRepository.rowsFor(KEY)).toHaveLength(0)
    })

    it('reports FALSE on a replay of the same challenge (the single-use guarantee)', async () => {
      const repository = createRepository()
      await repository.storeCodeChallenge(CHALLENGE)

      const first = await repository.removeCodeChallenge(CHALLENGE)
      const second = await repository.removeCodeChallenge(CHALLENGE)
      const third = await repository.removeCodeChallenge(CHALLENGE)

      expect([first, second, third]).toEqual([true, false, false])
    })

    /**
     * The whole finding, as one assertion: a `code_verifier` whose challenge was
     * never stored must be refused. The previous implementation answered `true`
     * here, which is what let `/auth/pkce_sign_in` be reached without the
     * MFA-verified `/login-params` call that stores the challenge.
     */
    it('reports FALSE for a challenge that was never stored', async () => {
      await expect(createRepository().removeCodeChallenge('never-issued')).resolves.toBe(false)
    })

    it('does not issue a DELETE when there is nothing live to remove', async () => {
      await createRepository().removeCodeChallenge('never-issued')

      expect(cacheEntryRepository.removeCalls).toBe(0)
    })

    it('reports FALSE for an expired challenge, and leaves another live one alone', async () => {
      const repository = createRepository()
      await repository.storeCodeChallenge(CHALLENGE)
      await repository.storeCodeChallenge('still-fresh')

      now += 3601 * 1000

      await expect(repository.removeCodeChallenge(CHALLENGE)).resolves.toBe(false)

      now = Date.parse('2026-10-09T12:00:00.000Z')
      await expect(repository.removeCodeChallenge('still-fresh')).resolves.toBe(true)
    })

    it('reports true once and removes EVERY duplicate row for the key', async () => {
      const repository = createRepository()
      await repository.storeCodeChallenge(CHALLENGE)
      await repository.storeCodeChallenge(CHALLENGE)

      expect(cacheEntryRepository.rowsFor(KEY)).toHaveLength(2)

      await expect(repository.removeCodeChallenge(CHALLENGE)).resolves.toBe(true)
      expect(cacheEntryRepository.rowsFor(KEY)).toHaveLength(0)
      await expect(repository.removeCodeChallenge(CHALLENGE)).resolves.toBe(false)
    })

    it('consuming one challenge does not consume another', async () => {
      const repository = createRepository()
      await repository.storeCodeChallenge(CHALLENGE)
      await repository.storeCodeChallenge('second-challenge')

      await expect(repository.removeCodeChallenge(CHALLENGE)).resolves.toBe(true)

      expect(cacheEntryRepository.rowsFor('pkce:second-challenge')).toHaveLength(1)
      await expect(repository.removeCodeChallenge('second-challenge')).resolves.toBe(true)
    })
  })
})

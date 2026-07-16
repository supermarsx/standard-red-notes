import { CacheEntry, CacheEntryRepositoryInterface } from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'

import { TypeORMProofOfWorkChallengeRepository } from './TypeORMProofOfWorkChallengeRepository'

/**
 * Minimal in-memory stand-in for the DB-cache-table repository, faithful to the
 * two behaviours the PoW store relies on: unexpired-only lookups and delete-by-key.
 */
class InMemoryCacheEntryRepository implements CacheEntryRepositoryInterface {
  readonly store = new Map<string, CacheEntry>()

  async save(cacheEntry: CacheEntry): Promise<void> {
    this.store.set(cacheEntry.props.key, cacheEntry)
  }

  async findUnexpiredOneByKey(key: string): Promise<CacheEntry | null> {
    const entry = this.store.get(key)
    if (!entry) {
      return null
    }
    const expiresAt = entry.props.expiresAt
    if (expiresAt !== null && expiresAt.getTime() <= Date.now()) {
      return null
    }

    return entry
  }

  async removeByKey(key: string): Promise<void> {
    this.store.delete(key)
  }
}

describe('TypeORMProofOfWorkChallengeRepository', () => {
  let cacheEntryRepository: InMemoryCacheEntryRepository
  let timer: TimerInterface
  let repository: TypeORMProofOfWorkChallengeRepository

  const secondsAhead = (seconds: number): Date => new Date(Date.now() + seconds * 1000)

  beforeEach(() => {
    cacheEntryRepository = new InMemoryCacheEntryRepository()

    timer = {
      getUTCDateNSecondsAhead: jest.fn().mockImplementation((seconds: number) => secondsAhead(seconds)),
    } as unknown as jest.Mocked<TimerInterface>

    repository = new TypeORMProofOfWorkChallengeRepository(cacheEntryRepository, timer)
  })

  describe('storeChallenge / getChallengeDifficulty', () => {
    it('round-trips the stored difficulty under a scoped key', async () => {
      await repository.storeChallenge('seed-1', 'register', 12, 600)

      expect(await repository.getChallengeDifficulty('seed-1', 'register')).toBe(12)
    })

    it('scopes the key so a register challenge cannot satisfy a sign-in lookup', async () => {
      await repository.storeChallenge('seed-1', 'register', 12, 600)

      expect(await repository.getChallengeDifficulty('seed-1', 'signIn')).toBeNull()
    })

    it('returns null for an unknown challenge', async () => {
      expect(await repository.getChallengeDifficulty('missing', 'register')).toBeNull()
    })

    it('returns null when the stored value is not a number (NaN guard)', async () => {
      await cacheEntryRepository.save(
        CacheEntry.create({
          key: 'pow:register:seed-1',
          value: 'not-a-number',
          expiresAt: secondsAhead(600),
        }).getValue(),
      )

      expect(await repository.getChallengeDifficulty('seed-1', 'register')).toBeNull()
    })

    it('returns null for an expired challenge', async () => {
      await cacheEntryRepository.save(
        CacheEntry.create({ key: 'pow:register:seed-1', value: '12', expiresAt: secondsAhead(-1) }).getValue(),
      )

      expect(await repository.getChallengeDifficulty('seed-1', 'register')).toBeNull()
    })
  })

  describe('consumeChallenge', () => {
    it('returns true once and FALSE on a second consume of the same key (single-use guarantee)', async () => {
      await repository.storeChallenge('seed-1', 'register', 12, 600)

      const first = await repository.consumeChallenge('seed-1', 'register')
      const second = await repository.consumeChallenge('seed-1', 'register')

      expect(first).toBe(true)
      expect(second).toBe(false)
    })

    it('returns false for an unknown challenge', async () => {
      expect(await repository.consumeChallenge('missing', 'signIn')).toBe(false)
    })

    it('returns false for an expired challenge without treating it as consumable', async () => {
      await cacheEntryRepository.save(
        CacheEntry.create({ key: 'pow:signIn:seed-1', value: '16', expiresAt: secondsAhead(-1) }).getValue(),
      )

      expect(await repository.consumeChallenge('seed-1', 'signIn')).toBe(false)
    })
  })
})

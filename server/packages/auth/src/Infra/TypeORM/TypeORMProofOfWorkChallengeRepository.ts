import { CacheEntry, CacheEntryRepositoryInterface } from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'

import { ProofOfWorkChallengeRepositoryInterface } from '../../Domain/ProofOfWork/ProofOfWorkChallengeRepositoryInterface'
import { ProofOfWorkScope } from '../../Domain/ProofOfWork/ProofOfWorkConfig'

/**
 * DB-cache-table backed proof-of-work challenge store, used when the auth server
 * is configured for the in-memory (TypeORM cache) backend instead of Redis.
 * Mirrors TypeORMPKCERepository. Single-use is enforced by removing the entry on
 * consume; unlike the Redis backend it cannot atomically report a lost race, so
 * under the rare in-memory backend two truly-simultaneous submissions of the
 * same seed could both pass — replay AFTER consumption is still blocked because
 * the entry is gone.
 */
export class TypeORMProofOfWorkChallengeRepository implements ProofOfWorkChallengeRepositoryInterface {
  private readonly PREFIX = 'pow'

  constructor(
    private cacheEntryRepository: CacheEntryRepositoryInterface,
    private timer: TimerInterface,
  ) {}

  private key(seed: string, scope: ProofOfWorkScope): string {
    return `${this.PREFIX}:${scope}:${seed}`
  }

  async storeChallenge(
    seed: string,
    scope: ProofOfWorkScope,
    difficulty: number,
    ttlSeconds: number,
  ): Promise<void> {
    await this.cacheEntryRepository.save(
      CacheEntry.create({
        key: this.key(seed, scope),
        value: difficulty.toString(),
        expiresAt: this.timer.getUTCDateNSecondsAhead(Math.max(1, Math.floor(ttlSeconds))),
      }).getValue(),
    )
  }

  async getChallengeDifficulty(seed: string, scope: ProofOfWorkScope): Promise<number | null> {
    const entry = await this.cacheEntryRepository.findUnexpiredOneByKey(this.key(seed, scope))
    if (entry === null) {
      return null
    }
    const difficulty = parseInt(entry.props.value, 10)

    return Number.isNaN(difficulty) ? null : difficulty
  }

  async consumeChallenge(seed: string, scope: ProofOfWorkScope): Promise<boolean> {
    await this.cacheEntryRepository.removeByKey(this.key(seed, scope))

    return true
  }
}

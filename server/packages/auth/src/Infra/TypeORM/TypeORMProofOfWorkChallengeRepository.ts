import { CacheEntry, CacheEntryRepositoryInterface } from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'

import { ProofOfWorkChallengeRepositoryInterface } from '../../Domain/ProofOfWork/ProofOfWorkChallengeRepositoryInterface'
import { ProofOfWorkScope } from '../../Domain/ProofOfWork/ProofOfWorkConfig'

/**
 * DB-cache-table backed proof-of-work challenge store, used when the auth server
 * is configured for the in-memory (TypeORM cache) backend instead of Redis.
 *
 * Single-use / replay protection: `consumeChallenge` first looks the entry up
 * (unexpired-only) and returns `false` when it is already gone or expired, so it
 * honours the same contract as the Redis backend (true iff THIS caller removed a
 * live entry). Replay AFTER consumption is fully blocked — the entry is gone, so
 * the lookup returns null and consume returns false.
 *
 * RESIDUAL ATOMICITY WINDOW: the shared CacheEntryRepositoryInterface exposes
 * only save / findUnexpiredOneByKey / removeByKey — there is no atomic
 * compare-and-delete or delete-returning-affected-rows — so the lookup and the
 * delete are two statements. Two *truly simultaneous* submissions of the SAME
 * seed can therefore both observe the live entry before either deletes it and
 * both return true. This window is a single DB round-trip wide and only exists
 * on the non-default in-memory backend (Redis uses an atomic DEL). The password
 * and MFA checks downstream are unaffected; the practical impact is that a bot
 * would, at worst, get one extra pass out of a single solved challenge under a
 * precisely-timed race — not unlimited replay.
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

  async storeChallenge(seed: string, scope: ProofOfWorkScope, difficulty: number, ttlSeconds: number): Promise<void> {
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
    const key = this.key(seed, scope)

    // Only report success if a LIVE (unexpired) entry existed for THIS caller to
    // remove — matching the Redis backend's `del === 1` contract so
    // VerifyProofOfWork's single-use race guard is honoured. Without this an
    // already-consumed or expired seed would still return true and defeat the
    // guard. See the class doc for the residual (non-atomic) concurrency window.
    const entry = await this.cacheEntryRepository.findUnexpiredOneByKey(key)
    if (entry === null) {
      return false
    }

    await this.cacheEntryRepository.removeByKey(key)

    return true
  }
}

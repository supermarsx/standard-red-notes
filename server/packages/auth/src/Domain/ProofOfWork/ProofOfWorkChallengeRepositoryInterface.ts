import { ProofOfWorkScope } from './ProofOfWorkConfig'

/**
 * Stores short-lived, single-use proof-of-work challenges (Redis-backed, TTL).
 *
 * Replay/reuse protection: a challenge is consumed with `consumeChallenge`,
 * which deletes it atomically and reports whether THIS caller was the one that
 * removed it. Only a single successful solution per issued seed is therefore
 * accepted, even under concurrent submissions.
 */
export interface ProofOfWorkChallengeRepositoryInterface {
  storeChallenge(seed: string, scope: ProofOfWorkScope, difficulty: number, ttlSeconds: number): Promise<void>
  /** Returns the difficulty the challenge was issued at, or null if unknown/expired/scope-mismatch. */
  getChallengeDifficulty(seed: string, scope: ProofOfWorkScope): Promise<number | null>
  /** Deletes the challenge. Returns true only if this call removed an existing entry (single-use guarantee). */
  consumeChallenge(seed: string, scope: ProofOfWorkScope): Promise<boolean>
}

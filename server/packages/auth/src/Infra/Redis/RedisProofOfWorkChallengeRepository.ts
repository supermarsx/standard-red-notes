import * as IORedis from 'ioredis'
import { inject, injectable } from 'inversify'

import TYPES from '../../Bootstrap/Types'
import { ProofOfWorkChallengeRepositoryInterface } from '../../Domain/ProofOfWork/ProofOfWorkChallengeRepositoryInterface'
import { ProofOfWorkScope } from '../../Domain/ProofOfWork/ProofOfWorkConfig'

@injectable()
export class RedisProofOfWorkChallengeRepository implements ProofOfWorkChallengeRepositoryInterface {
  private readonly PREFIX = 'pow'

  constructor(@inject(TYPES.Auth_Redis) private redisClient: IORedis.Redis) {}

  private key(seed: string, scope: ProofOfWorkScope): string {
    return `${this.PREFIX}:${scope}:${seed}`
  }

  async storeChallenge(seed: string, scope: ProofOfWorkScope, difficulty: number, ttlSeconds: number): Promise<void> {
    // The difficulty is stored server-side and is the ONLY authority during
    // verification, so a client cannot downgrade the work it must perform.
    await this.redisClient.setex(this.key(seed, scope), Math.max(1, Math.floor(ttlSeconds)), difficulty.toString())
  }

  async getChallengeDifficulty(seed: string, scope: ProofOfWorkScope): Promise<number | null> {
    const stored = await this.redisClient.get(this.key(seed, scope))
    if (stored === null) {
      return null
    }
    const difficulty = parseInt(stored, 10)

    return Number.isNaN(difficulty) ? null : difficulty
  }

  async consumeChallenge(seed: string, scope: ProofOfWorkScope): Promise<boolean> {
    const removed = await this.redisClient.del(this.key(seed, scope))

    return removed === 1
  }
}

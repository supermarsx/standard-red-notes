import * as crypto from 'crypto'
import { Result, UseCaseInterface } from '@standardnotes/domain-core'

import { ProofOfWorkChallengeRepositoryInterface } from '../../ProofOfWork/ProofOfWorkChallengeRepositoryInterface'
import { PROOF_OF_WORK_ALGORITHM } from '../../ProofOfWork/ProofOfWorkDifficulty'

import { RequestProofOfWorkChallengeDTO } from './RequestProofOfWorkChallengeDTO'
import { RequestProofOfWorkChallengeResult } from './RequestProofOfWorkChallengeResult'

/**
 * Standard Red Notes: mints a fresh, single-use proof-of-work challenge and
 * persists it (Redis, TTL) so it can later be verified once and only once. The
 * seed is high-entropy random, so a client cannot pre-compute solutions and an
 * attacker requesting challenges at scale still has to burn ~2^difficulty
 * hashes PER challenge — while the gateway rate-limiter caps how many
 * challenge-bearing requests any single IP can make in the first place.
 */
export class RequestProofOfWorkChallenge implements UseCaseInterface<RequestProofOfWorkChallengeResult> {
  private readonly SEED_BYTE_LENGTH = 24

  constructor(private challengeRepository: ProofOfWorkChallengeRepositoryInterface) {}

  async execute(dto: RequestProofOfWorkChallengeDTO): Promise<Result<RequestProofOfWorkChallengeResult>> {
    const seed = crypto.randomBytes(this.SEED_BYTE_LENGTH).toString('base64url')

    await this.challengeRepository.storeChallenge(seed, dto.scope, dto.difficulty, dto.ttlSeconds)

    return Result.ok({
      seed,
      difficulty: dto.difficulty,
      algorithm: PROOF_OF_WORK_ALGORITHM,
      ttlSeconds: dto.ttlSeconds,
    })
  }
}

import { Result, UseCaseInterface } from '@standardnotes/domain-core'

import { ProofOfWorkChallengeRepositoryInterface } from '../../ProofOfWork/ProofOfWorkChallengeRepositoryInterface'
import { proofOfWorkSolutionMeetsDifficulty } from '../../ProofOfWork/ProofOfWorkDifficulty'

import { VerifyProofOfWorkDTO } from './VerifyProofOfWorkDTO'

/**
 * Standard Red Notes: verifies a submitted proof-of-work solution. FAILS CLOSED.
 *
 * A solution is accepted only when ALL of the following hold:
 *  - `seed` and `nonce` are non-empty strings;
 *  - the seed corresponds to a challenge that was issued, is unexpired, and has
 *    not already been consumed (looked up by scope so a register challenge can
 *    never satisfy a sign-in and vice versa);
 *  - SHA-256(`${seed}:${nonce}`) meets the difficulty the server issued (the
 *    stored difficulty is authoritative — a client cannot downgrade it);
 *  - and the challenge is then atomically consumed (single-use). If another
 *    concurrent request consumed it first, verification fails.
 *
 * Any other outcome returns Result.fail(reason), and the caller MUST treat that
 * as "not solved" and re-issue a challenge.
 */
export class VerifyProofOfWork implements UseCaseInterface<void> {
  constructor(private challengeRepository: ProofOfWorkChallengeRepositoryInterface) {}

  async execute(dto: VerifyProofOfWorkDTO): Promise<Result<void>> {
    if (typeof dto.seed !== 'string' || dto.seed.length === 0) {
      return Result.fail('missing-solution')
    }
    if (typeof dto.nonce !== 'string' || dto.nonce.length === 0) {
      return Result.fail('missing-solution')
    }

    const difficulty = await this.challengeRepository.getChallengeDifficulty(dto.seed, dto.scope)
    if (difficulty === null) {
      return Result.fail('expired-or-unknown-challenge')
    }

    if (!proofOfWorkSolutionMeetsDifficulty(dto.seed, dto.nonce, difficulty)) {
      // Wrong nonce: do NOT consume, so an honest client can retry the same
      // seed until it expires.
      return Result.fail('insufficient-difficulty')
    }

    const consumed = await this.challengeRepository.consumeChallenge(dto.seed, dto.scope)
    if (!consumed) {
      // Lost the race (replay / concurrent submission of the same seed).
      return Result.fail('challenge-already-consumed')
    }

    return Result.ok()
  }
}

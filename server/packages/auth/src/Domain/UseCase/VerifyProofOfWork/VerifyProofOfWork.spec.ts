import * as crypto from 'crypto'

import { ProofOfWorkChallengeRepositoryInterface } from '../../ProofOfWork/ProofOfWorkChallengeRepositoryInterface'
import { countLeadingZeroBits } from '../../ProofOfWork/ProofOfWorkDifficulty'

import { VerifyProofOfWork } from './VerifyProofOfWork'

describe('VerifyProofOfWork', () => {
  let challengeRepository: ProofOfWorkChallengeRepositoryInterface

  const seed = 'a-random-seed'
  const difficulty = 8

  const solve = (forSeed: string, forDifficulty: number): string => {
    let nonce = 0
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const digest = crypto.createHash('sha256').update(`${forSeed}:${nonce}`).digest('hex')
      if (countLeadingZeroBits(digest) >= forDifficulty) {
        return nonce.toString()
      }
      nonce++
    }
  }

  const createUseCase = () => new VerifyProofOfWork(challengeRepository)

  beforeEach(() => {
    challengeRepository = {} as jest.Mocked<ProofOfWorkChallengeRepositoryInterface>
    challengeRepository.storeChallenge = jest.fn().mockResolvedValue(undefined)
    challengeRepository.getChallengeDifficulty = jest.fn().mockResolvedValue(difficulty)
    challengeRepository.consumeChallenge = jest.fn().mockResolvedValue(true)
  })

  it('accepts a valid solution and consumes the challenge exactly once', async () => {
    const nonce = solve(seed, difficulty)

    const result = await createUseCase().execute({ scope: 'register', seed, nonce })

    expect(result.isFailed()).toBe(false)
    expect(challengeRepository.consumeChallenge).toHaveBeenCalledTimes(1)
    expect(challengeRepository.consumeChallenge).toHaveBeenCalledWith(seed, 'register')
  })

  it('rejects a nonce that does not meet the issued difficulty (and does NOT consume)', async () => {
    challengeRepository.getChallengeDifficulty = jest.fn().mockResolvedValue(24)
    const weakNonce = solve(seed, 1)

    const result = await createUseCase().execute({ scope: 'register', seed, nonce: weakNonce })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe('insufficient-difficulty')
    expect(challengeRepository.consumeChallenge).not.toHaveBeenCalled()
  })

  it('rejects an expired/unknown challenge', async () => {
    challengeRepository.getChallengeDifficulty = jest.fn().mockResolvedValue(null)
    const nonce = solve(seed, difficulty)

    const result = await createUseCase().execute({ scope: 'signIn', seed, nonce })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe('expired-or-unknown-challenge')
  })

  it('rejects a reused challenge (lost the single-use consume race)', async () => {
    challengeRepository.consumeChallenge = jest.fn().mockResolvedValue(false)
    const nonce = solve(seed, difficulty)

    const result = await createUseCase().execute({ scope: 'register', seed, nonce })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe('challenge-already-consumed')
  })

  it('rejects a missing seed or nonce without hitting the store', async () => {
    const missingNonce = await createUseCase().execute({ scope: 'register', seed, nonce: '' })
    const missingSeed = await createUseCase().execute({ scope: 'register', seed: undefined, nonce: 'x' })

    expect(missingNonce.isFailed()).toBe(true)
    expect(missingSeed.isFailed()).toBe(true)
    expect(challengeRepository.getChallengeDifficulty).not.toHaveBeenCalled()
  })

  it('scopes lookups so a register challenge cannot satisfy a sign-in', async () => {
    const nonce = solve(seed, difficulty)

    await createUseCase().execute({ scope: 'signIn', seed, nonce })

    expect(challengeRepository.getChallengeDifficulty).toHaveBeenCalledWith(seed, 'signIn')
  })
})

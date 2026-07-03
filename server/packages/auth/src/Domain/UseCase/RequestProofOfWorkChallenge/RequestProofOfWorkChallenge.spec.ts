import { ProofOfWorkChallengeRepositoryInterface } from '../../ProofOfWork/ProofOfWorkChallengeRepositoryInterface'
import { PROOF_OF_WORK_ALGORITHM } from '../../ProofOfWork/ProofOfWorkDifficulty'

import { RequestProofOfWorkChallenge } from './RequestProofOfWorkChallenge'

describe('RequestProofOfWorkChallenge', () => {
  let challengeRepository: ProofOfWorkChallengeRepositoryInterface

  const createUseCase = () => new RequestProofOfWorkChallenge(challengeRepository)

  beforeEach(() => {
    challengeRepository = {} as jest.Mocked<ProofOfWorkChallengeRepositoryInterface>
    challengeRepository.storeChallenge = jest.fn().mockResolvedValue(undefined)
    challengeRepository.getChallengeDifficulty = jest.fn()
    challengeRepository.consumeChallenge = jest.fn()
  })

  it('mints and persists a fresh challenge for the given scope/difficulty/ttl', async () => {
    const result = await createUseCase().execute({ scope: 'signIn', difficulty: 16, ttlSeconds: 300 })

    expect(result.isFailed()).toBe(false)
    const challenge = result.getValue()
    expect(challenge.difficulty).toBe(16)
    expect(challenge.ttlSeconds).toBe(300)
    expect(challenge.algorithm).toBe(PROOF_OF_WORK_ALGORITHM)
    expect(typeof challenge.seed).toBe('string')
    expect(challenge.seed.length).toBeGreaterThan(0)
    expect(challengeRepository.storeChallenge).toHaveBeenCalledWith(challenge.seed, 'signIn', 16, 300)
  })

  it('produces a unique seed per call', async () => {
    const first = (await createUseCase().execute({ scope: 'register', difficulty: 12, ttlSeconds: 600 })).getValue()
    const second = (await createUseCase().execute({ scope: 'register', difficulty: 12, ttlSeconds: 600 })).getValue()

    expect(first.seed).not.toBe(second.seed)
  })
})

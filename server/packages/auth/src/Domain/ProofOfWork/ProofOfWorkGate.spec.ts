import { Result } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { LockRepositoryInterface } from '../User/LockRepositoryInterface'
import { UserRepositoryInterface } from '../User/UserRepositoryInterface'
import { RequestProofOfWorkChallenge } from '../UseCase/RequestProofOfWorkChallenge/RequestProofOfWorkChallenge'
import { VerifyProofOfWork } from '../UseCase/VerifyProofOfWork/VerifyProofOfWork'

import { IpEscalationCheckerInterface } from './IpEscalationCheckerInterface'
import { ProofOfWorkConfig } from './ProofOfWorkConfig'
import { ProofOfWorkConfigResolverInterface } from './ProofOfWorkConfigResolverInterface'
import { ProofOfWorkGate } from './ProofOfWorkGate'

describe('ProofOfWorkGate', () => {
  let requestChallenge: RequestProofOfWorkChallenge
  let verifyProofOfWork: VerifyProofOfWork
  let configResolver: ProofOfWorkConfigResolverInterface
  let lockRepository: LockRepositoryInterface
  let userRepository: UserRepositoryInterface
  let logger: Logger
  let config: ProofOfWorkConfig

  const challengePayload = { seed: 'seed', difficulty: 12, algorithm: 'sha256-leading-zero-bits', ttlSeconds: 600 }

  const createGate = () =>
    new ProofOfWorkGate(requestChallenge, verifyProofOfWork, configResolver, lockRepository, userRepository, logger)

  beforeEach(() => {
    config = {
      register: { enabled: true, difficulty: 12, ttlSeconds: 600 },
      signIn: { enabled: true, difficulty: 16, ttlSeconds: 600, mode: 'adaptive', adaptiveThreshold: 3 },
    }

    requestChallenge = {} as jest.Mocked<RequestProofOfWorkChallenge>
    requestChallenge.execute = jest.fn().mockResolvedValue(Result.ok(challengePayload))

    verifyProofOfWork = {} as jest.Mocked<VerifyProofOfWork>
    verifyProofOfWork.execute = jest.fn().mockResolvedValue(Result.fail('missing-solution'))

    configResolver = {} as jest.Mocked<ProofOfWorkConfigResolverInterface>
    configResolver.resolve = jest.fn().mockImplementation(() => Promise.resolve(config))

    lockRepository = {} as jest.Mocked<LockRepositoryInterface>
    lockRepository.getLockCounter = jest.fn().mockResolvedValue(0)

    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.findOneByUsernameOrEmail = jest.fn().mockResolvedValue(null)

    logger = { warn: jest.fn(), debug: jest.fn() } as unknown as jest.Mocked<Logger>
  })

  describe('register', () => {
    it('is satisfied without any check when register PoW is disabled', async () => {
      config.register.enabled = false

      const result = await createGate().enforceRegister({})

      expect(result.satisfied).toBe(true)
      expect(verifyProofOfWork.execute).not.toHaveBeenCalled()
    })

    it('is satisfied when a valid solution is presented', async () => {
      verifyProofOfWork.execute = jest.fn().mockResolvedValue(Result.ok())

      const result = await createGate().enforceRegister({ pow_seed: 's', pow_nonce: 'n' })

      expect(result.satisfied).toBe(true)
    })

    it('issues a fresh challenge when the solution is missing/invalid', async () => {
      const result = await createGate().enforceRegister({})

      expect(result.satisfied).toBe(false)
      if (!result.satisfied) {
        expect(result.challenge).toEqual(challengePayload)
      }
      expect(requestChallenge.execute).toHaveBeenCalledWith({ scope: 'register', difficulty: 12, ttlSeconds: 600 })
    })

    it('enforces a minimum effective difficulty of 1 when enabled but misconfigured to <= 0 (cannot fail open)', async () => {
      config.register.difficulty = 0

      const result = await createGate().enforceRegister({})

      expect(result.satisfied).toBe(false)
      expect(requestChallenge.execute).toHaveBeenCalledWith({ scope: 'register', difficulty: 1, ttlSeconds: 600 })
      expect(logger.warn).toHaveBeenCalled()
    })

    it('fails open when the config resolver throws', async () => {
      configResolver.resolve = jest.fn().mockRejectedValue(new Error('boom'))

      const result = await createGate().enforceRegister({})

      expect(result.satisfied).toBe(true)
      expect(logger.warn).toHaveBeenCalled()
    })
  })

  describe('sign-in', () => {
    it('skips the challenge entirely when bypassed (valid app password / trusted device)', async () => {
      const result = await createGate().enforceSignInParams('user@example.com', {}, true)

      expect(result.satisfied).toBe(true)
      expect(configResolver.resolve).not.toHaveBeenCalled()
    })

    it('is satisfied when sign-in PoW is disabled', async () => {
      config.signIn.enabled = false

      const result = await createGate().enforceSignInParams('user@example.com', {}, false)

      expect(result.satisfied).toBe(true)
    })

    it('always requires a challenge in "always" mode', async () => {
      config.signIn.mode = 'always'

      const result = await createGate().enforceSignInParams('user@example.com', {}, false)

      expect(result.satisfied).toBe(false)
      expect(requestChallenge.execute).toHaveBeenCalledWith({ scope: 'signIn', difficulty: 16, ttlSeconds: 600 })
    })

    it('does NOT require a challenge in adaptive mode below the failed-attempt threshold', async () => {
      lockRepository.getLockCounter = jest.fn().mockResolvedValue(1) // 1 + 1 = 2 < 3

      const result = await createGate().enforceSignInParams('user@example.com', {}, false)

      expect(result.satisfied).toBe(true)
      expect(requestChallenge.execute).not.toHaveBeenCalled()
    })

    it('requires a challenge in adaptive mode once the threshold is reached', async () => {
      lockRepository.getLockCounter = jest.fn().mockResolvedValue(2) // 2 + 2 = 4 >= 3

      const result = await createGate().enforceSignInParams('user@example.com', {}, false)

      expect(result.satisfied).toBe(false)
    })

    it('is satisfied with a valid solution even when required', async () => {
      config.signIn.mode = 'always'
      verifyProofOfWork.execute = jest.fn().mockResolvedValue(Result.ok())

      const result = await createGate().enforceSignInParams(
        'user@example.com',
        { pow_seed: 's', pow_nonce: 'n' },
        false,
      )

      expect(result.satisfied).toBe(true)
    })

    it('keys adaptive counters on the user uuid when the account exists', async () => {
      userRepository.findOneByUsernameOrEmail = jest.fn().mockResolvedValue({ uuid: 'user-uuid-123' })
      lockRepository.getLockCounter = jest.fn().mockResolvedValue(2) // 2 + 2 = 4 >= 3

      const result = await createGate().enforceSignInParams('user@example.com', {}, false)

      expect(result.satisfied).toBe(false)
      expect(lockRepository.getLockCounter).toHaveBeenCalledWith('user-uuid-123', 'non-captcha')
      expect(lockRepository.getLockCounter).toHaveBeenCalledWith('user-uuid-123', 'captcha')
    })

    it('treats an adaptive threshold of 0 as "always require"', async () => {
      config.signIn.adaptiveThreshold = 0

      const result = await createGate().enforceSignInParams('user@example.com', {}, false)

      expect(result.satisfied).toBe(false)
      expect(lockRepository.getLockCounter).not.toHaveBeenCalled()
    })

    it('fails open when the lock repository throws', async () => {
      lockRepository.getLockCounter = jest.fn().mockRejectedValue(new Error('redis down'))

      const result = await createGate().enforceSignInParams('user@example.com', {}, false)

      expect(result.satisfied).toBe(true)
      expect(logger.warn).toHaveBeenCalled()
    })
  })

  describe('sign-in with the gateway per-IP escalate flag', () => {
    let escalationChecker: jest.Mocked<IpEscalationCheckerInterface>

    const createGateWithEscalation = () =>
      new ProofOfWorkGate(
        requestChallenge,
        verifyProofOfWork,
        configResolver,
        lockRepository,
        userRepository,
        logger,
        escalationChecker,
      )

    beforeEach(() => {
      // Account is well below the adaptive threshold, so any escalation must come
      // purely from the IP flag.
      lockRepository.getLockCounter = jest.fn().mockResolvedValue(0)
      escalationChecker = {
        isEscalated: jest.fn().mockResolvedValue(false),
      } as jest.Mocked<IpEscalationCheckerInterface>
    })

    it('REQUIRES a challenge when the IP escalate flag is set, even below the account threshold', async () => {
      escalationChecker.isEscalated = jest.fn().mockResolvedValue(true)

      const result = await createGateWithEscalation().enforceSignInParams('user@example.com', {}, false, '1.2.3.4')

      expect(result.satisfied).toBe(false)
      expect(escalationChecker.isEscalated).toHaveBeenCalledWith('1.2.3.4')
    })

    it('does NOT require a challenge when the IP flag is unset and the account is below threshold', async () => {
      escalationChecker.isEscalated = jest.fn().mockResolvedValue(false)

      const result = await createGateWithEscalation().enforceSignInParams('user@example.com', {}, false, '1.2.3.4')

      expect(result.satisfied).toBe(true)
      expect(requestChallenge.execute).not.toHaveBeenCalled()
    })

    it('does not consult the IP flag when no client IP is provided', async () => {
      const result = await createGateWithEscalation().enforceSignInParams('user@example.com', {}, false)

      expect(result.satisfied).toBe(true)
      expect(escalationChecker.isEscalated).not.toHaveBeenCalled()
    })

    it('does not consult the IP flag when the client IP is an empty string', async () => {
      const result = await createGateWithEscalation().enforceSignInParams('user@example.com', {}, false, '')

      expect(result.satisfied).toBe(true)
      expect(escalationChecker.isEscalated).not.toHaveBeenCalled()
    })

    it('fails open when the IP escalation store is unavailable', async () => {
      escalationChecker.isEscalated = jest.fn().mockRejectedValue(new Error('redis unavailable'))

      const result = await createGateWithEscalation().enforceSignInParams('user@example.com', {}, false, '1.2.3.4')

      expect(result.satisfied).toBe(true)
      expect(logger.warn).toHaveBeenCalledWith('Proof-of-work sign-in gate failed open.', {
        errorType: 'Error',
        errorCode: undefined,
        status: undefined,
      })
      expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).not.toContain('redis unavailable')
    })

    it('still requires a challenge from the account threshold even if the IP flag is unset', async () => {
      lockRepository.getLockCounter = jest.fn().mockResolvedValue(2) // 2 + 2 = 4 >= 3
      escalationChecker.isEscalated = jest.fn().mockResolvedValue(false)

      const result = await createGateWithEscalation().enforceSignInParams('user@example.com', {}, false, '1.2.3.4')

      expect(result.satisfied).toBe(false)
    })
  })
})

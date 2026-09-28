import 'reflect-metadata'

import { RoleName } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { SessionRepositoryInterface } from '../Session/SessionRepositoryInterface'
import { LockRepositoryInterface } from './LockRepositoryInterface'
import { UserRepositoryInterface } from './UserRepositoryInterface'
import { LoginLockGuard, normalizeLockClientIp, progressiveLockDelaySeconds } from './LoginLockGuard'

describe('LoginLockGuard', () => {
  let userRepository: UserRepositoryInterface
  let lockRepository: LockRepositoryInterface
  let sessionRepository: SessionRepositoryInterface
  let logger: Logger

  const MAX_ATTEMPTS = 6
  const DELAY_CAP = 30

  const createGuard = (trustedSourceExemptionEnabled = true) =>
    new LoginLockGuard(
      userRepository,
      lockRepository,
      sessionRepository,
      MAX_ATTEMPTS,
      DELAY_CAP,
      trustedSourceExemptionEnabled,
      logger,
    )

  const asUser = (uuid: string, roles: string[] = []) =>
    ({ uuid, roles: Promise.resolve(roles.map((name) => ({ name }))) }) as never

  // jest.config sets resetMocks: true globally.
  beforeEach(() => {
    logger = { warn: jest.fn(), debug: jest.fn() } as unknown as jest.Mocked<Logger>

    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.findOneByUsernameOrEmail = jest.fn().mockResolvedValue(asUser('user-uuid'))
    userRepository.findUsersForAdmin = jest.fn().mockResolvedValue({ total: 5, users: [] })

    lockRepository = {} as jest.Mocked<LockRepositoryInterface>
    lockRepository.getLockCounter = jest.fn().mockResolvedValue(0)
    lockRepository.isUserLocked = jest.fn().mockResolvedValue(false)

    sessionRepository = {} as jest.Mocked<SessionRepositoryInterface>
    sessionRepository.findAllByUserUuid = jest.fn().mockResolvedValue([])
  })

  const signIn = (overrides: Record<string, unknown> = {}) => ({
    identifier: 'person@example.com',
    isRecoveryRoute: false,
    ...overrides,
  })

  describe('progressiveLockDelaySeconds', () => {
    /**
     * The ramp is the mitigation that costs an attacker real time WITHOUT taking
     * anything away from the account owner. Someone who mistyped their password
     * once or twice must wait exactly nothing.
     */
    it('should cost nothing below the threshold', () => {
      for (let attempts = 0; attempts < MAX_ATTEMPTS; attempts++) {
        expect(progressiveLockDelaySeconds(attempts, MAX_ATTEMPTS, DELAY_CAP)).toEqual(0)
      }
    })

    it('should double from the threshold and settle at the cap', () => {
      expect(progressiveLockDelaySeconds(6, MAX_ATTEMPTS, DELAY_CAP)).toEqual(1)
      expect(progressiveLockDelaySeconds(7, MAX_ATTEMPTS, DELAY_CAP)).toEqual(2)
      expect(progressiveLockDelaySeconds(8, MAX_ATTEMPTS, DELAY_CAP)).toEqual(4)
      expect(progressiveLockDelaySeconds(9, MAX_ATTEMPTS, DELAY_CAP)).toEqual(8)
      expect(progressiveLockDelaySeconds(10, MAX_ATTEMPTS, DELAY_CAP)).toEqual(16)
      expect(progressiveLockDelaySeconds(11, MAX_ATTEMPTS, DELAY_CAP)).toEqual(30)
      expect(progressiveLockDelaySeconds(12, MAX_ATTEMPTS, DELAY_CAP)).toEqual(30)
    })

    /**
     * A cap that could be exceeded would turn the back-off into the denial of
     * service it exists to prevent, and a corrupt counter must not produce
     * Infinity.
     */
    it('should never exceed the cap, whatever the counter says', () => {
      expect(progressiveLockDelaySeconds(500, MAX_ATTEMPTS, DELAY_CAP)).toEqual(30)
      expect(progressiveLockDelaySeconds(Number.MAX_SAFE_INTEGER, MAX_ATTEMPTS, DELAY_CAP)).toEqual(30)
      expect(progressiveLockDelaySeconds(Number.POSITIVE_INFINITY, MAX_ATTEMPTS, DELAY_CAP)).toEqual(0)
      expect(progressiveLockDelaySeconds(Number.NaN, MAX_ATTEMPTS, DELAY_CAP)).toEqual(0)
    })

    it('should be disabled by a zero cap', () => {
      expect(progressiveLockDelaySeconds(12, MAX_ATTEMPTS, 0)).toEqual(0)
    })
  })

  describe('normalizeLockClientIp', () => {
    it('should treat the IPv6-mapped IPv4 form as the same client', () => {
      expect(normalizeLockClientIp('::ffff:203.0.113.4')).toEqual('203.0.113.4')
      expect(normalizeLockClientIp(' 203.0.113.4 ')).toEqual('203.0.113.4')
      expect(normalizeLockClientIp('2001:DB8::1')).toEqual('2001:db8::1')
    })

    it('should yield an empty string for anything unusable', () => {
      expect(normalizeLockClientIp(undefined)).toEqual('')
      expect(normalizeLockClientIp(null)).toEqual('')
      expect(normalizeLockClientIp('')).toEqual('')
    })
  })

  describe('an account that is not locked', () => {
    it('should be allowed with no delay while below the threshold', async () => {
      const decision = await createGuard().evaluate(signIn())

      expect(decision).toEqual({ allowed: true, delaySeconds: 0, exemption: 'none', attempts: 0 })
    })

    it('should still be delayed once past the threshold', async () => {
      lockRepository.getLockCounter = jest.fn().mockResolvedValue(4)

      const decision = await createGuard().evaluate(signIn())

      expect(decision.allowed).toEqual(true)
      expect(decision.attempts).toEqual(8)
      expect(decision.delaySeconds).toEqual(4)
    })
  })

  describe('an account that IS locked', () => {
    beforeEach(() => {
      lockRepository.isUserLocked = jest.fn().mockResolvedValue(true)
      lockRepository.getLockCounter = jest.fn().mockResolvedValue(6)
    })

    it('should be refused by default', async () => {
      const decision = await createGuard().evaluate(signIn())

      expect(decision.allowed).toEqual(false)
      expect(decision.exemption).toEqual('none')
    })

    /**
     * THE DENIAL-OF-SERVICE ANSWER. The lock is account-scoped, so anyone who
     * knows an address can drive the counter. An address the owner has already
     * signed in from successfully must never be hard-refused, or a stranger
     * elsewhere can lock the owner out of their own encrypted notes.
     */
    it('should not refuse an address the account has already signed in from', async () => {
      sessionRepository.findAllByUserUuid = jest
        .fn()
        .mockResolvedValue([{ ipAddress: '198.51.100.7' }, { ipAddress: '203.0.113.4' }])

      const decision = await createGuard().evaluate(signIn({ clientIp: '203.0.113.4' }))

      expect(decision.allowed).toEqual(true)
      expect(decision.exemption).toEqual('trusted-source')
    })

    it('should match a known address through the IPv6-mapped form', async () => {
      sessionRepository.findAllByUserUuid = jest.fn().mockResolvedValue([{ ipAddress: '203.0.113.4' }])

      const decision = await createGuard().evaluate(signIn({ clientIp: '::ffff:203.0.113.4' }))

      expect(decision.exemption).toEqual('trusted-source')
    })

    it('should still refuse an address the account has never signed in from', async () => {
      sessionRepository.findAllByUserUuid = jest.fn().mockResolvedValue([{ ipAddress: '198.51.100.7' }])

      const decision = await createGuard().evaluate(signIn({ clientIp: '203.0.113.99' }))

      expect(decision.allowed).toEqual(false)
    })

    it('should refuse when no client address is known at all', async () => {
      sessionRepository.findAllByUserUuid = jest.fn().mockResolvedValue([{ ipAddress: '203.0.113.4' }])

      const decision = await createGuard().evaluate(signIn({ clientIp: undefined }))

      expect(decision.allowed).toEqual(false)
    })

    it('should refuse a known address when the exemption is switched off', async () => {
      sessionRepository.findAllByUserUuid = jest.fn().mockResolvedValue([{ ipAddress: '203.0.113.4' }])

      const decision = await createGuard(false).evaluate(signIn({ clientIp: '203.0.113.4' }))

      expect(decision.allowed).toEqual(false)
      expect(sessionRepository.findAllByUserUuid).not.toHaveBeenCalled()
    })

    /**
     * A TRADE, not pure safety, and recorded as one at the call site: an attacker
     * who knows an account is the sole administrator gets unlimited attempts
     * against it, bounded only by the delay ramp and the gateway's per-address
     * tier. An unrecoverable instance is worse.
     */
    it('should never hard-lock the last remaining administrator', async () => {
      userRepository.findOneByUsernameOrEmail = jest
        .fn()
        .mockResolvedValue(asUser('admin-uuid', [RoleName.NAMES.AdminUser]))
      userRepository.findUsersForAdmin = jest.fn().mockResolvedValue({ total: 1, users: [] })

      const decision = await createGuard().evaluate(signIn())

      expect(decision.allowed).toEqual(true)
      expect(decision.exemption).toEqual('last-administrator')
    })

    it('should lock an administrator when another administrator exists', async () => {
      userRepository.findOneByUsernameOrEmail = jest
        .fn()
        .mockResolvedValue(asUser('admin-uuid', [RoleName.NAMES.AdminUser]))
      userRepository.findUsersForAdmin = jest.fn().mockResolvedValue({ total: 2, users: [] })

      const decision = await createGuard().evaluate(signIn())

      expect(decision.allowed).toEqual(false)
    })

    it('should not treat a non-administrator as the last administrator', async () => {
      userRepository.findUsersForAdmin = jest.fn().mockResolvedValue({ total: 1, users: [] })

      const decision = await createGuard().evaluate(signIn())

      expect(decision.allowed).toEqual(false)
      expect(userRepository.findUsersForAdmin).not.toHaveBeenCalled()
    })
  })

  /**
   * CONDITION 2 — the recovery route is exempt from LOCKING, not from everything.
   * It is the owner's documented way back in, so refusing it means the lock
   * closes the very escape hatch it makes necessary. These tests hold the
   * exemption to exactly that scope so a later change cannot widen it silently.
   */
  describe('the recovery route', () => {
    beforeEach(() => {
      lockRepository.isUserLocked = jest.fn().mockResolvedValue(true)
      lockRepository.getLockCounter = jest.fn().mockResolvedValue(6)
    })

    it('should not be hard-refused while the account is locked', async () => {
      const decision = await createGuard().evaluate(signIn({ isRecoveryRoute: true }))

      expect(decision.allowed).toEqual(true)
      expect(decision.exemption).toEqual('recovery-route')
    })

    it('should STILL be delayed by the full ramp', async () => {
      const decision = await createGuard().evaluate(signIn({ isRecoveryRoute: true }))

      expect(decision.delaySeconds).toEqual(30)
      expect(decision.delaySeconds).toEqual(progressiveLockDelaySeconds(12, MAX_ATTEMPTS, DELAY_CAP))
    })

    /**
     * "Still counted" means the guard ALLOWS the request so the controller's
     * IncreaseLoginAttempts runs. If the guard ever short-circuited the route
     * before the controller, attempts would stop accruing and the exemption
     * would have become an exemption from everything.
     */
    it('should return allowed so the controller still counts the attempt', async () => {
      const decision = await createGuard().evaluate(signIn({ isRecoveryRoute: true }))

      expect(decision.allowed).toEqual(true)
      expect(decision.attempts).toEqual(12)
    })

    it('should be delayed like any other route when the account is not locked', async () => {
      lockRepository.isUserLocked = jest.fn().mockResolvedValue(false)
      lockRepository.getLockCounter = jest.fn().mockResolvedValue(4)

      const decision = await createGuard().evaluate(signIn({ isRecoveryRoute: true }))

      expect(decision.delaySeconds).toEqual(4)
    })
  })

  /**
   * The exemptions may only ever LOOSEN the outcome. On a lookup failure the
   * guard must degrade to exactly the behaviour that shipped before it existed —
   * never invent a refusal that would not otherwise have happened.
   */
  describe('failure direction', () => {
    beforeEach(() => {
      lockRepository.isUserLocked = jest.fn().mockResolvedValue(true)
      lockRepository.getLockCounter = jest.fn().mockResolvedValue(6)
    })

    it('should refuse, not crash, when the session lookup fails', async () => {
      sessionRepository.findAllByUserUuid = jest.fn().mockRejectedValue(new Error('cache down'))

      const decision = await createGuard().evaluate(signIn({ clientIp: '203.0.113.4' }))

      expect(decision.allowed).toEqual(false)
      expect(logger.warn).toHaveBeenCalled()
    })

    it('should refuse, not crash, when the administrator count fails', async () => {
      userRepository.findOneByUsernameOrEmail = jest
        .fn()
        .mockResolvedValue(asUser('admin-uuid', [RoleName.NAMES.AdminUser]))
      userRepository.findUsersForAdmin = jest.fn().mockRejectedValue(new Error('db down'))

      const decision = await createGuard().evaluate(signIn())

      expect(decision.allowed).toEqual(false)
      expect(logger.warn).toHaveBeenCalled()
    })
  })

  describe('identifier handling', () => {
    it('should key on the raw identifier when no account matches', async () => {
      userRepository.findOneByUsernameOrEmail = jest.fn().mockResolvedValue(null)
      lockRepository.isUserLocked = jest.fn().mockResolvedValue(true)

      const decision = await createGuard().evaluate(signIn())

      expect(decision.allowed).toEqual(false)
      expect(lockRepository.isUserLocked).toHaveBeenCalledWith('person@example.com')
    })

    /**
     * Matches SignIn and IncreaseLoginAttempts, which both skip the 2025 username
     * rules so legacy accounts still resolve. A guard that rejected those
     * identifiers would leave those accounts unprotected.
     */
    it('should accept legacy identifiers the 2025 username rules reject', async () => {
      lockRepository.isUserLocked = jest.fn().mockResolvedValue(true)

      const decision = await createGuard().evaluate(signIn({ identifier: 'john..doe@example.com' }))

      expect(decision.allowed).toEqual(false)
      expect(userRepository.findOneByUsernameOrEmail).toHaveBeenCalled()
    })

    it('should allow an empty identifier through to the ordinary credential check', async () => {
      const decision = await createGuard().evaluate(signIn({ identifier: '' }))

      expect(decision).toEqual({ allowed: true, delaySeconds: 0, exemption: 'none', attempts: 0 })
      expect(lockRepository.isUserLocked).not.toHaveBeenCalled()
    })
  })
})

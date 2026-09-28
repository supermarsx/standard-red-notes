import 'reflect-metadata'

import { Result } from '@standardnotes/domain-core'
import { Request, Response } from 'express'
import { Logger } from 'winston'

import { LoginLockGuard } from '../../../Domain/User/LoginLockGuard'
import { ProofOfWorkGate } from '../../../Domain/ProofOfWork/ProofOfWorkGate'
import { ClearLoginAttempts } from '../../../Domain/UseCase/ClearLoginAttempts'
import { IncreaseLoginAttempts } from '../../../Domain/UseCase/IncreaseLoginAttempts'
import { SignIn } from '../../../Domain/UseCase/SignIn'
import { SignInWithRecoveryCodes } from '../../../Domain/UseCase/SignInWithRecoveryCodes/SignInWithRecoveryCodes'
import { BaseAuthController } from './BaseAuthController'

/**
 * Standard Red Notes: lockout on the path Express middleware never reaches.
 *
 * Under the DirectCall (single-container) topology the gateway calls
 * Service.handleRequest, which looks the method up in the controller container
 * and invokes it directly — no Express middleware runs. LockMiddleware therefore
 * does not exist on that topology, and enforcement kept only there would mean a
 * single-container deployment enforced no account lockout at all while the build,
 * the annotations and the whole suite stayed green.
 *
 * These tests drive the controller the way DirectCall does: no middleware, and a
 * response object with no `locals` marker.
 */
describe('BaseAuthController login lock (DirectCall arm)', () => {
  let signInUseCase: SignIn
  let signInWithRecoveryCodes: SignInWithRecoveryCodes
  let increaseLoginAttempts: IncreaseLoginAttempts
  let clearLoginAttempts: ClearLoginAttempts
  let proofOfWorkGate: ProofOfWorkGate
  let loginLockGuard: LoginLockGuard
  let logger: Logger

  const allow = { allowed: true, delaySeconds: 0, exemption: 'none', attempts: 0 }
  const refuse = { allowed: false, delaySeconds: 0, exemption: 'none', attempts: 12 }

  const createController = (guard?: LoginLockGuard): BaseAuthController =>
    new BaseAuthController(
      {} as never,
      signInUseCase,
      {} as never,
      clearLoginAttempts,
      increaseLoginAttempts,
      logger,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      signInWithRecoveryCodes,
      {} as never,
      '',
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      proofOfWorkGate,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      guard,
    )

  const signInRequest = () =>
    ({
      body: {
        email: 'person@example.com',
        password: 'wrong-password',
        code_verifier: 'a-verifier-long-enough-to-pass-the-presence-check',
        api: '20200115',
      },
      headers: {},
      path: '/pkce_sign_in',
      originalUrl: '/auth/pkce_sign_in',
    }) as unknown as Request

  const recoveryRequest = () =>
    ({
      body: { username: 'person@example.com', recovery_codes: 'aaa bbb', code_verifier: 'verifier', api_version: '1' },
      headers: {},
      path: '/recovery/login',
      originalUrl: '/auth/recovery/login',
    }) as unknown as Request

  // jest.config sets resetMocks: true globally.
  beforeEach(() => {
    logger = { debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() } as unknown as jest.Mocked<Logger>

    signInUseCase = {
      execute: jest.fn().mockResolvedValue({ success: false, errorMessage: 'Invalid email or password' }),
    } as unknown as jest.Mocked<SignIn>

    signInWithRecoveryCodes = {
      execute: jest.fn().mockResolvedValue(Result.fail('Invalid recovery codes')),
    } as unknown as jest.Mocked<SignInWithRecoveryCodes>

    increaseLoginAttempts = {
      execute: jest.fn().mockResolvedValue(Result.ok({ isNonCaptchaLimitReached: false })),
    } as unknown as jest.Mocked<IncreaseLoginAttempts>

    clearLoginAttempts = {
      execute: jest.fn().mockResolvedValue(Result.ok()),
    } as unknown as jest.Mocked<ClearLoginAttempts>

    proofOfWorkGate = {
      enforceSignInParams: jest.fn().mockResolvedValue({ satisfied: true }),
    } as unknown as jest.Mocked<ProofOfWorkGate>

    loginLockGuard = { evaluate: jest.fn().mockResolvedValue(allow) } as unknown as jest.Mocked<LoginLockGuard>
  })

  it('should refuse a locked sign-in with 423 even though no middleware ran', async () => {
    loginLockGuard.evaluate = jest.fn().mockResolvedValue(refuse)
    const response = { locals: undefined, setHeader: jest.fn() } as unknown as Response

    const result = await createController(loginLockGuard).pkceSignIn(signInRequest(), response)

    expect(result.statusCode).toEqual(423)
    expect(signInUseCase.execute).not.toHaveBeenCalled()
  })

  it('should let an allowed sign-in reach the credential check', async () => {
    const response = { locals: undefined, setHeader: jest.fn() } as unknown as Response

    const result = await createController(loginLockGuard).pkceSignIn(signInRequest(), response)

    expect(result.statusCode).toEqual(401)
    expect(signInUseCase.execute).toHaveBeenCalled()
  })

  /**
   * On the HTTP topology LockMiddleware already evaluated and stalled. Evaluating
   * again here would double the back-off a legitimate user waits through.
   */
  it('should not evaluate again when the middleware already did', async () => {
    const response = { locals: { loginLockEvaluated: true }, setHeader: jest.fn() } as unknown as Response

    await createController(loginLockGuard).pkceSignIn(signInRequest(), response)

    expect(loginLockGuard.evaluate).not.toHaveBeenCalled()
  })

  it('should behave exactly as before when no guard is wired', async () => {
    const response = { locals: undefined, setHeader: jest.fn() } as unknown as Response

    const result = await createController(undefined).pkceSignIn(signInRequest(), response)

    expect(result.statusCode).toEqual(401)
    expect(signInUseCase.execute).toHaveBeenCalled()
  })

  /**
   * A fault in lock evaluation must never cost somebody access to their notes.
   * It falls through to the ordinary credential check, exactly as before.
   */
  it('should proceed when the guard itself throws', async () => {
    loginLockGuard.evaluate = jest.fn().mockRejectedValue(new Error('cache down'))
    const response = { locals: undefined, setHeader: jest.fn() } as unknown as Response

    const result = await createController(loginLockGuard).pkceSignIn(signInRequest(), response)

    expect(result.statusCode).toEqual(401)
    expect(signInUseCase.execute).toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalled()
  })

  describe('the recovery route', () => {
    /**
     * CONDITION 2 held at the controller: the guard never refuses the recovery
     * route, and the controller must still COUNT the failed attempt. If the route
     * ever stopped counting, the exemption would have quietly widened from
     * "exempt from hard locking" into "exempt from everything".
     */
    it('should still count a failed recovery attempt', async () => {
      const response = { locals: undefined, setHeader: jest.fn() } as unknown as Response

      await createController(loginLockGuard).recoveryLogin(recoveryRequest(), response)

      expect(loginLockGuard.evaluate).toHaveBeenCalledWith(expect.objectContaining({ isRecoveryRoute: true }))
      expect(increaseLoginAttempts.execute).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'person@example.com' }),
      )
    })

    it('should still be evaluated by the guard, so the delay ramp applies', async () => {
      loginLockGuard.evaluate = jest
        .fn()
        .mockResolvedValue({ allowed: true, delaySeconds: 0, exemption: 'recovery-route', attempts: 12 })
      const response = { locals: undefined, setHeader: jest.fn() } as unknown as Response

      await createController(loginLockGuard).recoveryLogin(recoveryRequest(), response)

      expect(loginLockGuard.evaluate).toHaveBeenCalledTimes(1)
    })
  })
})

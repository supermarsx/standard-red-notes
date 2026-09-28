import 'reflect-metadata'

import { Result } from '@standardnotes/domain-core'
import { Request, Response } from 'express'
import { Logger } from 'winston'

import { ProofOfWorkGate } from '../../../Domain/ProofOfWork/ProofOfWorkGate'
import { ClearLoginAttempts } from '../../../Domain/UseCase/ClearLoginAttempts'
import { IncreaseLoginAttempts } from '../../../Domain/UseCase/IncreaseLoginAttempts'
import { SignIn } from '../../../Domain/UseCase/SignIn'
import { BaseAuthController } from './BaseAuthController'

/**
 * Standard Red Notes: REGRESSION GUARD for the failed-login 500.
 *
 * Once the non-captcha tier is exhausted the sign-in path advertises a captcha
 * challenge with the `x-captcha-required` header. CAPTCHA_UI_URL is empty on
 * every deployment that does not run a captcha service — the default for
 * self-hosting — and Node rejects `setHeader(name, undefined)` with
 * ERR_HTTP_INVALID_HEADER_VALUE. The throw escaped the controller, so failed
 * attempts 6 through 12 (every attempt between the non-captcha threshold and the
 * lockout) answered 500 instead of 401 for somebody who simply mistyped their
 * password a few times. Live-reproduced on a stock compose stack.
 */
describe('BaseAuthController captcha-required header', () => {
  let signInUseCase: SignIn
  let increaseLoginAttempts: IncreaseLoginAttempts
  let clearLoginAttempts: ClearLoginAttempts
  let proofOfWorkGate: ProofOfWorkGate
  let logger: Logger

  // A faithful stand-in for Node's ServerResponse.setHeader: it THROWS on a
  // non-string value exactly as the real one does, so a test cannot pass by
  // recording a call that would have crashed in production.
  const createResponse = (): { response: Response; headers: Record<string, unknown> } => {
    const headers: Record<string, unknown> = {}
    const response = {
      setHeader: jest.fn((name: string, value: unknown) => {
        if (typeof value !== 'string' || value === '') {
          throw new TypeError(`Invalid value "${String(value)}" for header "${name}"`)
        }
        headers[name] = value
      }),
      locals: {},
    } as unknown as Response

    return { response, headers }
  }

  const createController = (captchaUIUrl: string): BaseAuthController =>
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
      {} as never,
      {} as never,
      captchaUIUrl,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      proofOfWorkGate,
      {} as never,
      {} as never,
      {} as never,
      // controllerContainer is optional; leaving it undefined keeps the
      // constructor from registering DirectCall handlers we do not exercise.
      undefined,
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
    }) as unknown as Request

  // jest.config sets resetMocks: true globally, so every implementation has to
  // be (re)established here rather than at declaration.
  beforeEach(() => {
    logger = { debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() } as unknown as jest.Mocked<Logger>

    signInUseCase = {
      execute: jest.fn().mockResolvedValue({ success: false, errorMessage: 'Invalid email or password' }),
    } as unknown as jest.Mocked<SignIn>

    increaseLoginAttempts = {
      execute: jest.fn().mockResolvedValue(Result.ok({ isNonCaptchaLimitReached: true })),
    } as unknown as jest.Mocked<IncreaseLoginAttempts>

    clearLoginAttempts = {
      execute: jest.fn().mockResolvedValue(Result.ok()),
    } as unknown as jest.Mocked<ClearLoginAttempts>

    proofOfWorkGate = {
      enforceSignInParams: jest.fn().mockResolvedValue({ satisfied: true }),
    } as unknown as jest.Mocked<ProofOfWorkGate>
  })

  it('should answer 401, not 500, past the non-captcha threshold when no captcha UI is configured', async () => {
    const { response, headers } = createResponse()

    const result = await createController('').pkceSignIn(signInRequest(), response)

    expect(result.statusCode).toEqual(401)
    expect(result.json).toEqual({ error: { message: 'Invalid email or password' } })
    expect(headers['x-captcha-required']).toBeUndefined()
  })

  it('should not attempt the header when the configured URL is undefined', async () => {
    const { response } = createResponse()

    // env.get(name, true) yields undefined for an unset CAPTCHA_UI_URL, and the
    // container binds that straight through, so the runtime value is not always
    // the `string` the constructor signature promises.
    const result = await createController(undefined as unknown as string).pkceSignIn(signInRequest(), response)

    expect(result.statusCode).toEqual(401)
    expect(response.setHeader).not.toHaveBeenCalledWith('x-captcha-required', expect.anything())
  })

  it('should not attempt the header when the configured URL is only whitespace', async () => {
    const { response } = createResponse()

    const result = await createController('   ').pkceSignIn(signInRequest(), response)

    expect(result.statusCode).toEqual(401)
    expect(response.setHeader).not.toHaveBeenCalledWith('x-captcha-required', expect.anything())
  })

  it('should still advertise the challenge when a captcha UI IS configured', async () => {
    const { response, headers } = createResponse()

    const result = await createController('https://captcha.example.com').pkceSignIn(signInRequest(), response)

    expect(result.statusCode).toEqual(401)
    expect(headers['x-captcha-required']).toEqual('https://captcha.example.com')
  })

  it('should not advertise a challenge before the non-captcha threshold is reached', async () => {
    increaseLoginAttempts.execute = jest.fn().mockResolvedValue(Result.ok({ isNonCaptchaLimitReached: false }))
    const { response, headers } = createResponse()

    const result = await createController('https://captcha.example.com').pkceSignIn(signInRequest(), response)

    expect(result.statusCode).toEqual(401)
    expect(headers['x-captcha-required']).toBeUndefined()
  })
})

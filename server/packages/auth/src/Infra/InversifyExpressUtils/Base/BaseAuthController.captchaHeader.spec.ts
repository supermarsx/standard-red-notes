import 'reflect-metadata'

import { readFileSync } from 'fs'
import { join } from 'path'

import { Result } from '@standardnotes/domain-core'
import { Request, Response } from 'express'
import { Logger } from 'winston'

import { ProofOfWorkGate } from '../../../Domain/ProofOfWork/ProofOfWorkGate'
import { ClearLoginAttempts } from '../../../Domain/UseCase/ClearLoginAttempts'
import { IncreaseLoginAttempts } from '../../../Domain/UseCase/IncreaseLoginAttempts'
import { SignIn } from '../../../Domain/UseCase/SignIn'
import { SignInWithRecoveryCodes } from '../../../Domain/UseCase/SignInWithRecoveryCodes/SignInWithRecoveryCodes'
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
  let signInWithRecoveryCodes: SignInWithRecoveryCodes
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
      signInWithRecoveryCodes,
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

  const recoveryRequest = () =>
    ({
      body: {
        username: 'person@example.com',
        recovery_codes: 'aaaa bbbb cccc',
        code_verifier: 'a-verifier-long-enough-to-pass-the-presence-check',
        api_version: '20200115',
      },
      headers: {},
      path: '/recovery/login',
      originalUrl: '/auth/recovery/login',
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

    signInWithRecoveryCodes = {
      execute: jest.fn().mockResolvedValue(Result.fail('Invalid recovery codes')),
    } as unknown as jest.Mocked<SignInWithRecoveryCodes>

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

  /**
   * The recovery route advertises the same challenge from its own call site, with
   * differently-named locals. The first fix converted only the sign-in site, and
   * the unit tests stayed green because none of them drove recoveryLogin — the
   * live probe found it. Hence both a behavioural test and the source guard below.
   */
  it('should answer the recovery route without 500-ing when no captcha UI is configured', async () => {
    const { response, headers } = createResponse()

    const result = await createController('').recoveryLogin(recoveryRequest(), response)

    expect(result.statusCode).not.toEqual(500)
    expect(headers['x-captcha-required']).toBeUndefined()
  })

  it('should still advertise the challenge on the recovery route when one IS configured', async () => {
    const { response, headers } = createResponse()

    await createController('https://captcha.example.com').recoveryLogin(recoveryRequest(), response)

    expect(headers['x-captcha-required']).toEqual('https://captcha.example.com')
  })

  /**
   * DRIFT GUARD. Two call sites advertise this header and a third could be added.
   * Every one of them must go through setCaptchaRequiredHeader, which is the only
   * place allowed to touch response.setHeader for it — a raw call anywhere else
   * reintroduces the 500 on every deployment with no captcha service, and no
   * behavioural test will catch it until someone exercises that exact path.
   */
  it('should route every captcha-header write through the single guarded helper', () => {
    const source = readFileSync(join(__dirname, 'BaseAuthController.ts'), 'utf8')
    // Strip comments first: the helper's own doc quotes the broken call verbatim,
    // and prose about the bug must not be mistaken for the bug.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

    const rawWrites = code.match(/response\.setHeader\(\s*'x-captcha-required'/g) ?? []
    expect(rawWrites).toHaveLength(1)

    // ...and that one write is the helper's own, which guards the value first.
    const helper = code.slice(code.indexOf('protected setCaptchaRequiredHeader'))
    expect(helper).toContain("response.setHeader('x-captcha-required'")
    expect(helper.slice(0, helper.indexOf("response.setHeader('x-captcha-required'"))).toContain(
      "this.captchaUIUrl.trim() === ''",
    )
  })
})

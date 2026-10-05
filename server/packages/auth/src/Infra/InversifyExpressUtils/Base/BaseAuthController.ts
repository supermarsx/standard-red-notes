import { ControllerContainerInterface, Username } from '@standardnotes/domain-core'
import { Request, Response } from 'express'
import { Logger } from 'winston'

import { ClearLoginAttempts } from '../../../Domain/UseCase/ClearLoginAttempts'
import { GetUserKeyParams } from '../../../Domain/UseCase/GetUserKeyParams/GetUserKeyParams'
import { IncreaseLoginAttempts } from '../../../Domain/UseCase/IncreaseLoginAttempts'
import { SignIn } from '../../../Domain/UseCase/SignIn'
import { VerifyMFA } from '../../../Domain/UseCase/VerifyMFA'
import { AuthController } from '../../../Controller/AuthController'
import { ResponseLocals } from '../ResponseLocals'
import { BaseHttpController, results } from 'inversify-express-utils'
import { Session } from '../../../Domain/Session/Session'
import { ErrorTag, HttpStatusCode } from '@standardnotes/responses'
import { Register } from '../../../Domain/UseCase/Register'
import { ProtocolVersion } from '@standardnotes/common'
import { DomainEventPublisherInterface } from '@standardnotes/domain-events'
import { DomainEventFactoryInterface } from '../../../Domain/Event/DomainEventFactoryInterface'
import { SessionServiceInterface } from '../../../Domain/Session/SessionServiceInterface'
import { AuthResponse20161215 } from '../../../Domain/Auth/AuthResponse20161215'
import { VerifyHumanInteraction } from '../../../Domain/UseCase/VerifyHumanInteraction/VerifyHumanInteraction'
import { CookieFactoryInterface } from '../../../Domain/Auth/Cookies/CookieFactoryInterface'
import { SignInWithRecoveryCodes } from '../../../Domain/UseCase/SignInWithRecoveryCodes/SignInWithRecoveryCodes'
import { DeleteSessionByToken } from '../../../Domain/UseCase/DeleteSessionByToken/DeleteSessionByToken'
import { VerifyAppPassword } from '../../../Domain/UseCase/VerifyAppPassword/VerifyAppPassword'
import { VerifyTrustedDevice } from '../../../Domain/UseCase/VerifyTrustedDevice/VerifyTrustedDevice'
import { CreatePendingMfaApproval } from '../../../Domain/UseCase/CreatePendingMfaApproval/CreatePendingMfaApproval'
import { UserRepositoryInterface } from '../../../Domain/User/UserRepositoryInterface'
import { VerifyMFAResponse } from '../../../Domain/UseCase/VerifyMFAResponse'
import { ProofOfWorkGate, ProofOfWorkChallengePayload } from '../../../Domain/ProofOfWork/ProofOfWorkGate'
import { VerifyEmailConfirmation } from '../../../Domain/UseCase/VerifyEmailConfirmation/VerifyEmailConfirmation'
import { ResendEmailConfirmation } from '../../../Domain/UseCase/ResendEmailConfirmation/ResendEmailConfirmation'
import { GetAccountRecoveryEscrow } from '../../../Domain/UseCase/GetAccountRecoveryEscrow/GetAccountRecoveryEscrow'
import { safeErrorLogMetadata } from '../../../Domain/Logging/SafeLog'
import { LoginLockGuard } from '../../../Domain/User/LoginLockGuard'
import { resolveLoginLockRequest, sleepSeconds } from '../Middleware/LoginLockRequest'

const PROOF_OF_WORK_REQUIRED_TAG = 'proof-of-work-required'

export class BaseAuthController extends BaseHttpController {
  constructor(
    protected verifyMFA: VerifyMFA,
    protected signInUseCase: SignIn,
    protected getUserKeyParams: GetUserKeyParams,
    protected clearLoginAttempts: ClearLoginAttempts,
    protected increaseLoginAttempts: IncreaseLoginAttempts,
    protected logger: Logger,
    protected authController: AuthController,
    protected registerUser: Register,
    protected domainEventPublisher: DomainEventPublisherInterface,
    protected domainEventFactory: DomainEventFactoryInterface,
    protected sessionService: SessionServiceInterface,
    protected humanVerificationUseCase: VerifyHumanInteraction,
    protected cookieFactory: CookieFactoryInterface,
    protected signInWithRecoveryCodes: SignInWithRecoveryCodes,
    protected deleteSessionByToken: DeleteSessionByToken,
    protected captchaUIUrl: string,
    protected verifyAppPassword: VerifyAppPassword,
    protected verifyTrustedDevice: VerifyTrustedDevice,
    protected createPendingMfaApproval: CreatePendingMfaApproval,
    protected userRepository: UserRepositoryInterface,
    protected proofOfWorkGate: ProofOfWorkGate,
    // Standard Red Notes: EMAIL CONFIRMATION (part 2). Public endpoints to verify
    // a confirmation token and to resend the confirmation email.
    protected verifyEmailConfirmationUseCase: VerifyEmailConfirmation,
    protected resendEmailConfirmationUseCase: ResendEmailConfirmation,
    protected getAccountRecoveryEscrow: GetAccountRecoveryEscrow,
    protected controllerContainer?: ControllerContainerInterface,
    // Standard Red Notes: failed-login lockout for the DirectCall topology, where
    // Express middleware never runs. Trailing optional so existing call sites and
    // specs keep compiling; absent means the controller enforces nothing and the
    // middleware remains the only arm, exactly as before.
    protected loginLockGuard?: LoginLockGuard,
  ) {
    super()

    if (this.controllerContainer !== undefined) {
      this.controllerContainer.register('auth.pkceParams', this.pkceParams.bind(this))
      this.controllerContainer.register('auth.pkceSignIn', this.pkceSignIn.bind(this))
      this.controllerContainer.register('auth.users.register', this.register.bind(this))
      this.controllerContainer.register('auth.generateRecoveryCodes', this.generateRecoveryCodes.bind(this))
      this.controllerContainer.register('auth.signInWithRecoveryCodes', this.recoveryLogin.bind(this))
      this.controllerContainer.register('auth.recoveryKeyParams', this.recoveryParams.bind(this))
      this.controllerContainer.register('auth.accountRecovery.lookup', this.accountRecoveryLookup.bind(this))
      this.controllerContainer.register('auth.signOut', this.signOut.bind(this))
      this.controllerContainer.register('auth.emailConfirmation.verify', this.verifyEmailConfirmation.bind(this))
      this.controllerContainer.register('auth.emailConfirmation.resend', this.resendEmailConfirmation.bind(this))
    }
  }

  /**
   * Standard Red Notes: failed-login lockout on the path middleware cannot reach.
   *
   * LockMiddleware guards /auth/pkce_sign_in and /auth/recovery/login on the HTTP
   * topology, but under DirectCall (single container) the gateway calls
   * Service.handleRequest, which invokes the registered controller method
   * directly and runs NO Express middleware — so enforcement kept only in the
   * middleware is absent there entirely. Both arms consult the same
   * LoginLockGuard so the two topologies cannot drift apart.
   *
   * When the middleware already ran it marks `response.locals`, and this returns
   * immediately rather than evaluating the guard (and stalling) a second time.
   *
   * With no guard bound — older wiring, and every existing spec that constructs
   * this controller positionally — this is a no-op, so behaviour is unchanged
   * unless the guard is present.
   */
  protected async enforceLoginLock(request: Request, response?: Response): Promise<results.JsonResult | null> {
    if (this.loginLockGuard === undefined) {
      return null
    }
    if ((response?.locals as Record<string, unknown> | undefined)?.loginLockEvaluated === true) {
      return null
    }

    try {
      const decision = await this.loginLockGuard.evaluate(resolveLoginLockRequest(request))

      // The delay applies to refusals and exemptions alike: an exemption buys an
      // attacker patience, never speed.
      await sleepSeconds(decision.delaySeconds)

      if (!decision.allowed) {
        return this.json(
          { error: { message: 'Too many successive login requests. Please try your request again later.' } },
          423,
        )
      }
    } catch (error) {
      // Never let a lock-evaluation fault cost somebody access to their notes:
      // fall through to the ordinary credential check, exactly as before.
      this.logger.warn('Login lock evaluation failed; allowing the request to proceed.', safeErrorLogMetadata(error))
    }

    return null
  }

  /**
   * Standard Red Notes: advertise the captcha challenge URL once the non-captcha
   * failed-login tier is exhausted — but ONLY when one is actually configured.
   *
   * CAPTCHA_UI_URL is empty on every deployment that does not run a captcha
   * service, which is the default for self-hosting. `env.get(..., true)` yields
   * undefined there, so this used to call
   * `response.setHeader('x-captcha-required', undefined)`, which Node rejects
   * with ERR_HTTP_INVALID_HEADER_VALUE. The throw escaped the controller and the
   * request became a 500.
   *
   * The practical effect was that failed sign-in attempts 6 through 12 — every
   * attempt between the non-captcha threshold and the lockout — answered
   * "500 Internal Server Error" instead of "401 invalid credentials", on the
   * ordinary path where somebody simply mistyped their password a few times.
   * Live-reproduced on a stock compose stack before this fix.
   *
   * Skipping the header when there is nothing to point at is also the honest
   * signal: a client cannot solve a challenge that this deployment does not
   * serve, so claiming one is required would be a dead end.
   */
  protected setCaptchaRequiredHeader(response: Response): void {
    if (typeof this.captchaUIUrl !== 'string' || this.captchaUIUrl.trim() === '') {
      return
    }

    response.setHeader('x-captcha-required', this.captchaUIUrl)
  }

  /**
   * Standard Red Notes: PUBLIC. Consumes an email-confirmation token from the
   * verification link. Returns 200 on success (including a friendly
   * already-confirmed), 400 with a clear message on invalid/expired/used.
   */
  async verifyEmailConfirmation(request: Request): Promise<results.JsonResult> {
    const token = typeof request.body?.token === 'string' ? request.body.token : ''

    const result = await this.verifyEmailConfirmationUseCase.execute({ token })
    if (result.isFailed()) {
      return this.json({ error: { message: result.getError() } }, HttpStatusCode.BadRequest)
    }

    const response = result.getValue()
    if (!response.success) {
      return this.json({ error: { message: response.errorMessage } }, HttpStatusCode.BadRequest)
    }

    return this.json({ success: true, alreadyConfirmed: response.alreadyConfirmed === true })
  }

  /**
   * Standard Red Notes: PUBLIC. Re-sends the confirmation email. ALWAYS 200 with
   * a uniform body so it never becomes an account-existence oracle. Rate-limited
   * at the gateway (auth-sensitive tier).
   */
  async resendEmailConfirmation(request: Request): Promise<results.JsonResult> {
    const email = typeof request.body?.email === 'string' ? request.body.email : ''

    await this.resendEmailConfirmationUseCase.execute({ email })

    return this.json({ success: true })
  }

  private proofOfWorkRequiredResponse(challenge: ProofOfWorkChallengePayload, status: number): results.JsonResult {
    return this.json(
      {
        error: {
          tag: PROOF_OF_WORK_REQUIRED_TAG,
          message: 'Please complete the verification challenge and try again.',
          payload: {
            pow: {
              seed: challenge.seed,
              difficulty: challenge.difficulty,
              algorithm: challenge.algorithm,
              ttl_seconds: challenge.ttlSeconds,
            },
          },
        },
      },
      status,
    )
  }

  async pkceParams(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    if (!request.body.code_challenge) {
      return this.json(
        {
          error: {
            message: 'Please provide the code challenge parameter.',
          },
        },
        400,
      )
    }

    if (locals.session) {
      const result = await this.getUserKeyParams.execute({
        email: locals.user.email,
        authenticated: true,
        codeChallenge: request.body.code_challenge as string,
      })

      return this.json(result.keyParams)
    }

    if (!request.body.email) {
      return this.json(
        {
          error: {
            message: 'Please provide an email address.',
          },
        },
        400,
      )
    }

    /**
     * Standard Red Notes: THE SECOND FACTOR IS A CREDENTIAL, SO THIS ROUTE IS A
     * CREDENTIAL CHECK AND HAS TO BE TREATED AS ONE.
     *
     * This is where VerifyMFA runs — a TOTP, a U2F assertion, a magic-link code,
     * an app password or a trusted-device token is accepted or rejected here, with
     * no session required. Yet lockout enforcement lived only on /pkce_sign_in and
     * /recovery/login (LockMiddleware on those two routes, enforceLoginLock in
     * those two controller methods), and no gateway rate-limit bucket covered
     * `/v1/login-params` or `/v2/login-params` either. A second factor could
     * therefore be guessed as fast as the network allowed: a 6-digit TOTP is 10^6
     * wide, and a magic-link code is 6 NUMERIC digits that stay valid for fifteen
     * minutes with no per-code attempt limit of its own.
     *
     * Evaluating the guard here puts the progressive delay ramp and the hard lock
     * on the second-factor gate, and the increment added to the failure branch
     * below is what makes that ramp climb. Counting without consulting the guard
     * would have left the counter rising while this route still answered at full
     * speed — the increment feeds the ramp; it is not itself a brake.
     *
     * Placed AFTER the authenticated `locals.session` branch deliberately: an
     * already-signed-in client fetching its own key params (credential change, key
     * rotation) presents no second factor and must not be held behind an attacker-
     * driven lock counter. For the same reason the guard is NOT attached to the
     * route as middleware — middleware would run before the session is resolved.
     */
    const lockedOut = await this.enforceLoginLock(request, response)
    if (lockedOut !== null) {
      return lockedOut
    }

    // Standard Red Notes: app-password 2FA bypass for headless/automation clients
    // (e.g. the MCP bridge). If the request carries a valid app password we treat
    // the interactive MFA challenge as satisfied for THIS sign-in only. This does
    // NOT change account-password sign-in: a missing or wrong app password makes
    // `appPasswordSatisfiesMfa` false and we fall through to the normal MFA
    // enforcement below. VerifyAppPassword fails closed (constant-time bcrypt
    // compare), so a wrong app password behaves exactly like a failed MFA.
    //
    // Caveat: an app password only affects server-side auth / the 2FA gate. The
    // account's end-to-end encryption key is still derived client-side from the
    // real account password; an app password never grants decryption.
    let appPasswordSatisfiesMfa = false
    const presentedAppPassword = request.body.app_password
    if (typeof presentedAppPassword === 'string' && presentedAppPassword.length > 0) {
      const appPasswordResult = await this.verifyAppPassword.execute({
        email: request.body.email as string,
        appPassword: presentedAppPassword,
      })
      appPasswordSatisfiesMfa = !appPasswordResult.isFailed() && appPasswordResult.getValue() === true
    }

    // Standard Red Notes: trusted-device 2FA bypass. If the request carries a
    // valid, non-expired trusted-device token for this account we treat the
    // interactive MFA challenge as satisfied for THIS sign-in only. This mirrors
    // the app-password bypass above and obeys the same fail-closed contract:
    // VerifyTrustedDevice returns false for any wrong/expired/revoked/missing
    // token, in which case we fall through to normal MFA enforcement. Trust
    // bypasses ONLY the second factor — the account password is still verified
    // in SignIn, and the e2e encryption key is still derived client-side from
    // the real account password (trust never grants decryption).
    let trustedDeviceSatisfiesMfa = false
    let trustedDeviceTokenPresented = false
    if (!appPasswordSatisfiesMfa) {
      const presentedDeviceToken = request.body.trusted_device_token
      if (typeof presentedDeviceToken === 'string' && presentedDeviceToken.length > 0) {
        trustedDeviceTokenPresented = true
        const trustedDeviceResult = await this.verifyTrustedDevice.execute({
          email: request.body.email as string,
          deviceToken: presentedDeviceToken,
        })
        trustedDeviceSatisfiesMfa = !trustedDeviceResult.isFailed() && trustedDeviceResult.getValue() === true
      }
    }

    // Standard Red Notes: privacy-preserving proof-of-work anti-bot gate.
    // A valid app password or trusted device pre-authorizes the client and skips
    // the challenge entirely (the legit-automation escape hatch). Otherwise, when
    // proof-of-work is required for sign-in (config: always, or adaptively after
    // N failed attempts) and no valid solution is presented, we return a fresh
    // challenge for the client to solve and resubmit. This is cheap for the
    // server (a single hash to verify) and burns ~2^difficulty hashes for a bot.
    const proofOfWorkBypass = appPasswordSatisfiesMfa || trustedDeviceSatisfiesMfa
    const signInProofOfWork = await this.proofOfWorkGate.enforceSignInParams(
      request.body.email as string,
      request.body,
      proofOfWorkBypass,
      // Standard Red Notes: the client IP the gateway forwards (x-origin-ip). Lets
      // the gate consult the shared per-IP escalate flag so an abusive IP is
      // challenged even before its account crosses the adaptive threshold.
      (request.headers['x-origin-ip'] as string) ?? undefined,
    )
    if (!signInProofOfWork.satisfied) {
      return this.proofOfWorkRequiredResponse(signInProofOfWork.challenge, 401)
    }

    const verifyMFAResponse: VerifyMFAResponse =
      appPasswordSatisfiesMfa || trustedDeviceSatisfiesMfa
        ? { success: true }
        : await this.verifyMFA.execute({
            email: request.body.email as string,
            requestParams: request.body,
            preventOTPFromFurtherUsage: true,
          })

    if (!verifyMFAResponse.success) {
      /**
       * Standard Red Notes: COUNT THE REJECTED SECOND FACTOR.
       *
       * increaseLoginAttempts was previously called only on a failed ACCOUNT
       * PASSWORD (pkceSignIn) and a failed recovery-code sign-in. A wrong TOTP, a
       * wrong magic-link code, a wrong app password and a wrong trusted-device
       * token all cost the attacker nothing: the counter never moved, so the
       * progressive delay ramp never started climbing, the hard lock was never
       * reached, and the adaptive proof-of-work threshold
       * (ProofOfWorkGate.adaptiveRequirementReached, which reads the very same
       * lock counters) was never crossed either.
       *
       * WHAT IS COUNTED, AND WHY NOT EVERYTHING. Only an attempt that actually
       * PRESENTED a second factor and had it REJECTED:
       *
       *   - ErrorTag.MfaInvalid — a wrong/reused TOTP, a failed U2F assertion, a
       *     wrong/expired/consumed magic-link code. Every brute-force guess lands
       *     here by construction, so nothing a guesser can do avoids the counter.
       *   - a presented app password that did not verify, and a presented
       *     trusted-device token that did not verify. Both are second-factor
       *     credentials; both are bcrypt compares, so leaving them uncounted also
       *     left an unmetered CPU cost.
       *
       * A bare "mfa-required" / "u2f-required" response is NOT counted. That is
       * the FIRST round trip of every single sign-in on a 2FA account — the client
       * cannot know a code is wanted until the server says so — and it carries no
       * guess at all. Counting it would mean every legitimate 2FA sign-in spent
       * lockout budget, and would hand any stranger who knows an email address a
       * one-request-per-step denial of service against an account they cannot
       * otherwise touch. The volumetric side of that probing is the gateway rate
       * limiter's job (bucket `auth-second-factor`), not the lock counter's.
       *
       * Deliberate consequence, stated plainly: a mistyped second factor now
       * counts toward lockout exactly as a mistyped password does. The counter is
       * cleared by a COMPLETED sign-in (pkceSignIn, below) rather than here — see
       * the note there for why a satisfied second factor alone must not reset it.
       */
      const appPasswordRejected =
        typeof presentedAppPassword === 'string' && presentedAppPassword.length > 0 && !appPasswordSatisfiesMfa
      const trustedDeviceRejected = trustedDeviceTokenPresented && !trustedDeviceSatisfiesMfa
      const secondFactorWasRejected =
        verifyMFAResponse.errorTag === ErrorTag.MfaInvalid || appPasswordRejected || trustedDeviceRejected

      if (secondFactorWasRejected) {
        const increaseResultOrError = await this.increaseLoginAttempts.execute({
          email: request.body.email as string,
          skipUsernameValidation: true,
        })
        if (increaseResultOrError.isFailed()) {
          this.logger.error('Failed to increase login attempts after a rejected second factor.', {
            application: request.headers['x-application-version'] as string,
          })
        } else if (increaseResultOrError.getValue().isNonCaptchaLimitReached) {
          this.setCaptchaRequiredHeader(response)
        }
      }

      // Standard Red Notes: push-MFA. When an untrusted device hits the 2FA
      // challenge, create a short-lived pending approval and push a request to
      // the user's other trusted sessions over the websocket gateway. The
      // challenge id is returned alongside the normal MFA error so the new
      // device can ADDITIONALLY poll for push approval while still showing the
      // interactive TOTP input. Best-effort: any failure here leaves the
      // standard TOTP flow fully intact.
      let mfaApprovalChallengeId: string | undefined
      try {
        const usernameOrError = Username.create(request.body.email as string, { skipValidation: true })
        if (!usernameOrError.isFailed()) {
          const user = await this.userRepository.findOneByUsernameOrEmail(usernameOrError.getValue())
          if (user) {
            const approvalResult = await this.createPendingMfaApproval.execute({
              userUuid: user.uuid,
              requestingUserAgent: (request.headers['user-agent'] as string) ?? '',
              requestingIpAddress: (request.headers['x-origin-ip'] as string) ?? null,
            })
            if (!approvalResult.isFailed()) {
              mfaApprovalChallengeId = approvalResult.getValue().challengeId
            }
          }
        }
      } catch (error) {
        this.logger.debug('Could not create a pending MFA approval.', safeErrorLogMetadata(error))
      }

      return this.json(
        {
          error: {
            tag: verifyMFAResponse.errorTag,
            message: verifyMFAResponse.errorMessage,
            payload: {
              ...verifyMFAResponse.errorPayload,
              ...(mfaApprovalChallengeId ? { mfa_approval_challenge_id: mfaApprovalChallengeId } : {}),
            },
          },
        },
        401,
      )
    }

    const result = await this.getUserKeyParams.execute({
      email: request.body.email as string,
      authenticated: false,
      codeChallenge: request.body.code_challenge as string,
      // Standard Red Notes: optional workspace name (WORKSPACES_PER_EMAIL_ENABLED).
      // Undefined/absent when the feature is off — the use case ignores it
      // entirely unless the server flag is on.
      workspaceIdentifier: request.body.workspace_identifier as string | undefined,
    })

    return this.json(result.keyParams)
  }

  async pkceSignIn(request: Request, response: Response): Promise<results.JsonResult> {
    const locked = await this.enforceLoginLock(request, response)
    if (locked !== null) {
      return locked
    }

    if (!request.body.email || !request.body.password || !request.body.code_verifier) {
      this.logger.debug('/auth/pkce_sign_in request is missing one or more required credential fields', {
        hasEmail: typeof request.body.email === 'string' && request.body.email.length > 0,
        hasPassword: typeof request.body.password === 'string' && request.body.password.length > 0,
        hasCodeVerifier: typeof request.body.code_verifier === 'string' && request.body.code_verifier.length > 0,
      })

      return this.json(
        {
          error: {
            tag: 'invalid-auth',
            message: 'Invalid login credentials.',
          },
        },
        401,
      )
    }

    const signInResult = await this.signInUseCase.execute({
      apiVersion: request.body.api,
      userAgent: request.headers['user-agent'] as string,
      email: request.body.email,
      password: request.body.password,
      ephemeralSession: request.body.ephemeral ?? false,
      codeVerifier: request.body.code_verifier,
      hvmToken: request.body.hvm_token,
      snjs: request.headers['x-snjs-version'] as string,
      application: request.headers['x-application-version'] as string,
      ipAddress: (request.headers['x-origin-ip'] as string) ?? null,
      // Standard Red Notes: optional workspace name (WORKSPACES_PER_EMAIL_ENABLED).
      // Ignored by the use case unless the server flag is on.
      workspaceIdentifier: request.body.workspace_identifier as string | undefined,
    })

    if (!signInResult.success) {
      const resultOrError = await this.increaseLoginAttempts.execute({
        email: request.body.email,
        skipUsernameValidation: true,
      })
      if (resultOrError.isFailed()) {
        this.logger.error('Failed to increase login attempts.', {
          application: request.headers['x-application-version'] as string,
        })
      } else {
        const result = resultOrError.getValue()
        if (result.isNonCaptchaLimitReached) {
          this.setCaptchaRequiredHeader(response)
        }
      }

      return this.json(
        {
          error: {
            message: signInResult.errorMessage,
          },
        },
        401,
      )
    }

    /**
     * Standard Red Notes: THE ONLY PLACE THE COUNTER IS CLEARED, and deliberately
     * so now that a rejected second factor also increments it (see pkceParams).
     *
     * A completed sign-in has proven BOTH factors, so clearing here cannot be
     * provoked by half a credential: somebody who mistypes their TOTP twice and
     * then signs in successfully is back to zero one request later, exactly as
     * somebody who mistypes their password twice always has been.
     *
     * Clearing at the second-factor gate instead would have been a real
     * regression: /login-params verifies no account password, so a holder of the
     * second factor alone (a stolen TOTP seed, an intercepted magic-link code)
     * could reset the PASSWORD lockout counter at will and brute-force the
     * password indefinitely — alternating a guess against /pkce_sign_in with a
     * counter reset against /login-params. The clear belongs where both factors
     * have been shown, and that is here.
     */
    await this.clearLoginAttempts.execute({ email: request.body.email })

    if (signInResult.result.response !== undefined) {
      const session = signInResult.result.session as Session
      const user = signInResult.result.response.user

      response.setHeader(
        'Set-Cookie',
        this.cookieFactory.createCookieHeaderValue({
          sessionUuid: session.uuid,
          accessToken: signInResult.result.cookies?.accessToken as string,
          refreshToken: signInResult.result.cookies?.refreshToken as string,
          refreshTokenExpiration: session.refreshExpiration,
        }),
      )

      return this.json({
        session: signInResult.result.response.sessionBody,
        key_params: signInResult.result.response.keyParams,
        user,
      })
    }

    return this.json(signInResult.result.legacyResponse)
  }

  async generateRecoveryCodes(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    const result = await this.authController.generateRecoveryCodes({
      userUuid: locals.user.uuid,
      serverPassword: request.headers['x-server-password'] as string | undefined,
      authTokenVersion: locals.authTokenVersion,
    })

    return this.json(result.data, result.status)
  }

  async recoveryLogin(request: Request, response: Response): Promise<results.JsonResult> {
    // Still evaluated, so the recovery route is still DELAYED by the ramp; the
    // guard never returns a refusal for it. See LoginLockGuard.evaluate().
    const locked = await this.enforceLoginLock(request, response)
    if (locked !== null) {
      return locked
    }

    const result = await this.signInWithRecoveryCodes.execute({
      apiVersion: request.body.api_version,
      userAgent: request.headers['user-agent'] as string,
      codeVerifier: request.body.code_verifier,
      username: request.body.username,
      recoveryCodes: request.body.recovery_codes,
      password: request.body.password,
      hvmToken: request.body.hvm_token,
      snjs: request.headers['x-snjs-version'] as string,
      application: request.headers['x-application-version'] as string,
      ipAddress: (request.headers['x-origin-ip'] as string) ?? null,
    })

    if (result.isFailed()) {
      this.logger.debug('Failed to sign in with recovery codes.')

      const increasLoginAttemtpsResultOrError = await this.increaseLoginAttempts.execute({
        email: request.body.username,
      })
      if (increasLoginAttemtpsResultOrError.isFailed()) {
        this.logger.error('Failed to increase login attempts on recovery login.', {
          application: request.headers['x-application-version'] as string,
        })
      } else {
        const increasLoginAttemtpsResult = increasLoginAttemtpsResultOrError.getValue()
        if (increasLoginAttemtpsResult.isNonCaptchaLimitReached) {
          this.setCaptchaRequiredHeader(response)
        }
      }

      return this.json(
        {
          error: {
            message: 'Invalid login credentials.',
          },
        },
        HttpStatusCode.Unauthorized,
      )
    }

    await this.clearLoginAttempts.execute({ email: request.body.username })

    const signInWithRecoveryCodesResult = result.getValue()

    return this.json({
      session: signInWithRecoveryCodesResult.sessionBody,
      key_params: signInWithRecoveryCodesResult.keyParams,
      user: signInWithRecoveryCodesResult.user,
    })
  }

  async recoveryParams(request: Request): Promise<results.JsonResult> {
    const result = await this.authController.recoveryKeyParams({
      apiVersion: request.body.api_version,
      username: request.body.username,
      codeChallenge: request.body.code_challenge,
      recoveryCodes: request.body.recovery_codes,
    })

    return this.json(result.data, result.status)
  }

  async accountRecoveryLookup(request: Request): Promise<results.JsonResult> {
    const userUuid = typeof request.body?.user_uuid === 'string' ? request.body.user_uuid : ''
    const result = await this.getAccountRecoveryEscrow.execute({ userUuid })

    if (result.isFailed()) {
      return this.json(
        {
          error: {
            message: 'Account recovery is unavailable.',
          },
        },
        404,
      )
    }

    const lookup = result.getValue()
    return this.json({
      escrow: lookup.escrow,
      identifier: lookup.identifier,
      workspace_identifier: lookup.workspaceIdentifier,
    })
  }

  async signOut(request: Request, response: Response): Promise<results.JsonResult | void> {
    const locals = response.locals as ResponseLocals

    if (locals.readOnlyAccess) {
      return this.json(
        {
          error: {
            tag: ErrorTag.ReadOnlyAccess,
            message: 'Session has read-only access.',
          },
        },
        HttpStatusCode.Unauthorized,
      )
    }

    const authCookies = new Map<string, string[]>()
    request.headers.cookie?.split(';').forEach((cookie) => {
      const parts = cookie.split('=')
      if (parts.length === 2 && parts[0].trim().startsWith('access_token_')) {
        const existingCookies = authCookies.get(parts[0].trim())
        if (existingCookies) {
          existingCookies.push(parts[1].trim())
          authCookies.set(parts[0].trim(), existingCookies)
        } else {
          authCookies.set(parts[0].trim(), [parts[1].trim()])
        }
      }
    })

    const authTokenFromHeaders = (request.headers.authorization as string).replace('Bearer ', '')

    const resultOrError = await this.deleteSessionByToken.execute({
      authTokenFromHeaders,
      authCookies,
      requestMetadata: {
        snjs: request.headers['x-snjs-version'] as string,
        application: request.headers['x-application-version'] as string,
        url: request.headers['x-origin-url'] as string,
        method: request.headers['x-origin-method'] as string,
        userAgent: request.headers['x-origin-user-agent'] as string,
        secChUa: request.headers['x-origin-sec-ch-ua'] as string,
      },
    })
    if (resultOrError.isFailed()) {
      return this.json(
        {
          error: {
            message: 'Invalid session token.',
          },
        },
        HttpStatusCode.Unauthorized,
      )
    }
    const session = resultOrError.getValue()

    response.setHeader(
      'Set-Cookie',
      this.cookieFactory.createCookieHeaderValue({
        sessionUuid: session.uuid,
        accessToken: '0',
        refreshToken: '0',
        refreshTokenExpiration: new Date(1),
      }),
    )

    if (session.userUuid !== null) {
      response.setHeader('x-invalidate-cache', session.userUuid)
    }

    return this.json({}, HttpStatusCode.NoContent)
  }

  async register(request: Request, response: Response): Promise<results.JsonResult> {
    const hvmToken = request.body.hvm_token
    const humanVerificationResult = await this.humanVerificationUseCase.execute(hvmToken)

    if (humanVerificationResult.isFailed()) {
      return this.json(
        {
          error: {
            message: humanVerificationResult.getError(),
          },
        },
        HttpStatusCode.BadRequest,
      )
    }

    if (!request.body.email || !request.body.password) {
      return this.json(
        {
          error: {
            message: 'Please enter an email and a password to register.',
          },
        },
        HttpStatusCode.BadRequest,
      )
    }

    // Standard Red Notes: privacy-preserving proof-of-work anti-bot gate for
    // registration (defaults to always-on at a low difficulty). When enabled and
    // no valid solution is presented, return a fresh challenge for the client to
    // solve and resubmit. Disabled server-side => this is a no-op and the client
    // never sees a challenge.
    const registerProofOfWork = await this.proofOfWorkGate.enforceRegister(request.body)
    if (!registerProofOfWork.satisfied) {
      return this.proofOfWorkRequiredResponse(registerProofOfWork.challenge, HttpStatusCode.BadRequest)
    }

    const registerResult = await this.registerUser.execute({
      email: request.body.email,
      password: request.body.password,
      updatedWithUserAgent: request.headers['user-agent'] as string,
      apiVersion: request.body.api,
      ephemeralSession: request.body.ephemeral,
      pwNonce: request.body.pw_nonce,
      kpOrigination: request.body.origination,
      kpCreated: request.body.created,
      version: request.body.version,
      snjs: request.headers['x-snjs-version'] as string,
      application: request.headers['x-application-version'] as string,
      ipAddress: (request.headers['x-origin-ip'] as string) ?? null,
      // Standard Red Notes: optional workspace name (WORKSPACES_PER_EMAIL_ENABLED).
      // Ignored by the use case unless the server flag is on.
      workspaceIdentifier: request.body.workspace_identifier as string | undefined,
      // Standard Red Notes: optional client-supplied device id — the SOFT
      // per-device signup cap consults it only when the per-device cap is on and
      // the client actually sent one. Forgeable by design (not a security signal).
      deviceId: request.body.device_id as string | undefined,
      // Standard Red Notes: optional raw signup-invite token (from the `?invite=`
      // URL). Required in invite-only mode (fail-closed), honored + consumed when
      // present in open mode. Passes through the gateway register proxy untouched.
      inviteToken: request.body.invite_token as string | undefined,
    })

    if (!registerResult.success) {
      return this.json(
        {
          error: {
            message: registerResult.errorMessage,
          },
        },
        HttpStatusCode.BadRequest,
      )
    }

    // Standard Red Notes: APPROVAL QUEUE. A pending signup created no session and
    // hands back no user/keyParams — return a 200 with a pendingApproval flag and
    // NO Set-Cookie so the web UI shows "awaiting approval" instead of signing in.
    if ('pendingApproval' in registerResult) {
      return this.json({ pendingApproval: true })
    }

    // Strict email-confirmation registration is also terminal: the user exists
    // but Register intentionally created no session. Return a stable 200 marker
    // with no Set-Cookie or token-shaped fields so clients can show the inbox
    // prompt without mistaking the account for authenticated.
    if ('emailConfirmationRequired' in registerResult) {
      return this.json({ emailConfirmationRequired: true })
    }

    const registeredUser = registerResult.result.response
      ? registerResult.result.response.user
      : (registerResult.result.legacyResponse as AuthResponse20161215).user

    await this.clearLoginAttempts.execute({ email: registeredUser.email })

    try {
      await this.domainEventPublisher.publish(
        this.domainEventFactory.createUserRegisteredEvent({
          userUuid: registeredUser.uuid,
          email: registeredUser.email,
          protocolVersion: registeredUser.protocolVersion as ProtocolVersion,
        }),
      )
    } catch (error) {
      this.logger.error('Failed to publish USER_REGISTERED event after registration was committed.', {
        userId: registeredUser.uuid,
        ...safeErrorLogMetadata(error),
      })
    }

    if (registerResult.result.response === undefined) {
      return this.json(registerResult.result.legacyResponse)
    }

    const session = registerResult.result.session as Session

    response.setHeader(
      'Set-Cookie',
      this.cookieFactory.createCookieHeaderValue({
        sessionUuid: session.uuid,
        accessToken: registerResult.result.cookies?.accessToken as string,
        refreshToken: registerResult.result.cookies?.refreshToken as string,
        refreshTokenExpiration: session.refreshExpiration,
      }),
    )

    return this.json({
      session: registerResult.result.response.sessionBody,
      key_params: registerResult.result.response.keyParams,
      user: registeredUser,
    })
  }
}

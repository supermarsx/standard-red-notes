import { ControllerContainerInterface } from '@standardnotes/domain-core'
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
import { Username } from '@standardnotes/domain-core'
import { VerifyMFAResponse } from '../../../Domain/UseCase/VerifyMFAResponse'
import { ProofOfWorkGate, ProofOfWorkChallengePayload } from '../../../Domain/ProofOfWork/ProofOfWorkGate'
import { VerifyEmailConfirmation } from '../../../Domain/UseCase/VerifyEmailConfirmation/VerifyEmailConfirmation'
import { ResendEmailConfirmation } from '../../../Domain/UseCase/ResendEmailConfirmation/ResendEmailConfirmation'

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
    protected controllerContainer?: ControllerContainerInterface,
  ) {
    super()

    if (this.controllerContainer !== undefined) {
      this.controllerContainer.register('auth.pkceParams', this.pkceParams.bind(this))
      this.controllerContainer.register('auth.pkceSignIn', this.pkceSignIn.bind(this))
      this.controllerContainer.register('auth.users.register', this.register.bind(this))
      this.controllerContainer.register('auth.generateRecoveryCodes', this.generateRecoveryCodes.bind(this))
      this.controllerContainer.register('auth.signInWithRecoveryCodes', this.recoveryLogin.bind(this))
      this.controllerContainer.register('auth.recoveryKeyParams', this.recoveryParams.bind(this))
      this.controllerContainer.register('auth.signOut', this.signOut.bind(this))
      this.controllerContainer.register('auth.emailConfirmation.verify', this.verifyEmailConfirmation.bind(this))
      this.controllerContainer.register('auth.emailConfirmation.resend', this.resendEmailConfirmation.bind(this))
    }
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
    if (!appPasswordSatisfiesMfa) {
      const presentedDeviceToken = request.body.trusted_device_token
      if (typeof presentedDeviceToken === 'string' && presentedDeviceToken.length > 0) {
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

    const verifyMFAResponse: VerifyMFAResponse = appPasswordSatisfiesMfa || trustedDeviceSatisfiesMfa
      ? { success: true }
      : await this.verifyMFA.execute({
          email: request.body.email as string,
          requestParams: request.body,
          preventOTPFromFurtherUsage: true,
        })

    if (!verifyMFAResponse.success) {
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
        this.logger.debug(`Could not create pending MFA approval: ${(error as Error).message}`)
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
    if (!request.body.email || !request.body.password || !request.body.code_verifier) {
      this.logger.debug('/auth/pkce_sign_in request missing credentials: %O', request.body)

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
        this.logger.error(`Failed to increase login attempts: ${resultOrError.getError()}`, {
          application: request.headers['x-application-version'] as string,
        })
      } else {
        const result = resultOrError.getValue()
        if (result.isNonCaptchaLimitReached) {
          response.setHeader('x-captcha-required', this.captchaUIUrl)
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
      this.logger.debug(`Failed to sign in with recovery codes: ${result.getError()}`)

      const increasLoginAttemtpsResultOrError = await this.increaseLoginAttempts.execute({
        email: request.body.username,
      })
      if (increasLoginAttemtpsResultOrError.isFailed()) {
        this.logger.error(
          `Failed to increase login attempts on recovery login: ${increasLoginAttemtpsResultOrError.getError()}`,
          {
            application: request.headers['x-application-version'] as string,
          },
        )
      } else {
        const increasLoginAttemtpsResult = increasLoginAttemtpsResultOrError.getValue()
        if (increasLoginAttemtpsResult.isNonCaptchaLimitReached) {
          response.setHeader('x-captcha-required', this.captchaUIUrl)
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

    const registeredUser = registerResult.result.response
      ? registerResult.result.response.user
      : (registerResult.result.legacyResponse as AuthResponse20161215).user

    await this.clearLoginAttempts.execute({ email: registeredUser.email })

    await this.domainEventPublisher.publish(
      this.domainEventFactory.createUserRegisteredEvent({
        userUuid: registeredUser.uuid,
        email: registeredUser.email,
        protocolVersion: registeredUser.protocolVersion as ProtocolVersion,
      }),
    )

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

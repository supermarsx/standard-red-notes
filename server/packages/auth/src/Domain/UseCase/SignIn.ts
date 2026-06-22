import * as bcrypt from 'bcryptjs'
import { DomainEventPublisherInterface } from '@standardnotes/domain-events'

import { Logger } from 'winston'
import { AuthResponseFactoryResolverInterface } from '../Auth/AuthResponseFactoryResolverInterface'
import { DomainEventFactoryInterface } from '../Event/DomainEventFactoryInterface'
import { SessionServiceInterface } from '../Session/SessionServiceInterface'
import { User } from '../User/User'
import { UserRepositoryInterface } from '../User/UserRepositoryInterface'
import { SignInDTO } from './SignInDTO'
import { SignInResponse } from './SignInResponse'
import { UseCaseInterface } from './UseCaseInterface'
import { PKCERepositoryInterface } from '../User/PKCERepositoryInterface'
import { CrypterInterface } from '../Encryption/CrypterInterface'
import { EmailLevel, Result, Username } from '@standardnotes/domain-core'
import { getBody, getSubject } from '../Email/UserSignedIn'
import { ApiVersion } from '../Api/ApiVersion'
import { HttpStatusCode } from '@standardnotes/responses'
import { VerifyHumanInteraction } from './VerifyHumanInteraction/VerifyHumanInteraction'
import { LockRepositoryInterface } from '../User/LockRepositoryInterface'
import { AuditLogWriterInterface } from '../AuditLog/AuditLogWriterInterface'
import { AuditAction } from '../AuditLog/AuditAction'
import { WebhookDispatcherInterface } from '../Webhook/WebhookDispatcherInterface'
import { WebhookEvent } from '../Webhook/WebhookEvent'

export class SignIn implements UseCaseInterface {
  constructor(
    private userRepository: UserRepositoryInterface,
    private authResponseFactoryResolver: AuthResponseFactoryResolverInterface,
    private domainEventPublisher: DomainEventPublisherInterface,
    private domainEventFactory: DomainEventFactoryInterface,
    private sessionService: SessionServiceInterface,
    private pkceRepository: PKCERepositoryInterface,
    private crypter: CrypterInterface,
    private logger: Logger,
    private maxNonCaptchaAttempts: number,
    private lockRepository: LockRepositoryInterface,
    private verifyHumanInteractionUseCase: VerifyHumanInteraction,
    // Standard Red Notes: "multiple accounts per email" flag. Default OFF
    // (trailing optional param so existing call sites/specs are unchanged).
    private workspacesPerEmailEnabled = false,
    // Standard Red Notes: optional integration hooks (trailing optional params so
    // existing call sites/specs are unchanged). When provided, SignIn records
    // login success/failure to the audit log and fires the `user.login` webhook.
    private auditLogWriter?: AuditLogWriterInterface,
    private webhookDispatcher?: WebhookDispatcherInterface,
  ) {}

  async execute(dto: SignInDTO): Promise<SignInResponse> {
    if (!dto.codeVerifier) {
      return {
        success: false,
        errorMessage: 'Please update your client application.',
        errorCode: HttpStatusCode.Gone,
      }
    }

    const validCodeVerifier = await this.validateCodeVerifier(dto.codeVerifier)
    if (!validCodeVerifier) {
      this.logger.debug('Code verifier does not match')

      return {
        success: false,
        errorMessage: 'Invalid email or password',
      }
    }

    const apiVersionOrError = ApiVersion.create(dto.apiVersion)
    if (apiVersionOrError.isFailed()) {
      return {
        success: false,
        errorMessage: apiVersionOrError.getError(),
      }
    }
    const apiVersion = apiVersionOrError.getValue()

    /** Skip validation which was newly added in 2025, to allow existing users to continue to sign in */
    const usernameOrError = Username.create(dto.email, { skipValidation: true })
    if (usernameOrError.isFailed()) {
      return {
        success: false,
        errorMessage: usernameOrError.getError(),
      }
    }
    const username = usernameOrError.getValue()

    // Standard Red Notes: with the feature ON, resolve the specific workspace by
    // the composite (email, workspaceIdentifier); an absent/empty value targets
    // the 'default' workspace. A non-matching pair yields no user and falls
    // through to the standard "Invalid email or password" path below, so no
    // additional information about which workspaces exist is leaked. With the
    // flag OFF, the historical email-only lookup is preserved exactly.
    const user = this.workspacesPerEmailEnabled
      ? await this.userRepository.findOneByEmailAndWorkspaceIdentifier(
          username,
          this.normalizeWorkspaceIdentifier(dto.workspaceIdentifier),
        )
      : await this.userRepository.findOneByUsernameOrEmail(username)
    const userIdentifier = user?.uuid ?? dto.email

    const humanVerificationBeforeCheckingUsernameAndPasswordResult = await this.checkHumanVerificationIfNeeded(
      userIdentifier,
      dto.hvmToken,
    )
    if (humanVerificationBeforeCheckingUsernameAndPasswordResult.isFailed()) {
      return {
        success: false,
        errorMessage: humanVerificationBeforeCheckingUsernameAndPasswordResult.getError(),
      }
    }

    if (!user) {
      this.logger.debug(`User with email ${dto.email} was not found`)

      return {
        success: false,
        errorMessage: 'Invalid email or password',
      }
    }

    const passwordMatches = await bcrypt.compare(dto.password, user.encryptedPassword)
    if (!passwordMatches) {
      this.logger.debug('Password does not match')

      await this.recordLoginFailure(user.uuid, dto.email, dto.ipAddress, 'invalid_password')

      return {
        success: false,
        errorMessage: 'Invalid email or password',
      }
    }

    /**
     * Standard Red Notes: a banned user (set by an admin) cannot sign in even
     * with valid credentials. Checked after the password verifies so the ban
     * status is never disclosed to an attacker who does not know the password.
     */
    if (user.isBanned()) {
      this.logger.debug(`[sign-in][${user.uuid}] Banned user attempted to sign in.`)

      await this.recordLoginFailure(user.uuid, dto.email, dto.ipAddress, 'banned')

      return {
        success: false,
        errorMessage: 'This account has been suspended. Please contact an administrator.',
        errorCode: HttpStatusCode.Forbidden,
      }
    }

    const authResponseFactory = this.authResponseFactoryResolver.resolveAuthResponseFactoryVersion(apiVersion)

    await this.sendSignInEmailNotification(user, dto.userAgent)

    const result = await authResponseFactory.createResponse({
      user,
      apiVersion,
      userAgent: dto.userAgent,
      ephemeralSession: dto.ephemeralSession,
      readonlyAccess: false,
      snjs: dto.snjs,
      application: dto.application,
      ipAddress: dto.ipAddress,
    })

    await this.recordLoginSuccess(user.uuid, dto.ipAddress)

    return {
      success: true,
      result,
    }
  }

  // Standard Red Notes: best-effort audit + webhook on a successful sign-in. Both
  // hooks are optional and never throw, so they cannot affect the sign-in result.
  private async recordLoginSuccess(userUuid: string, ipAddress?: string | null): Promise<void> {
    if (this.auditLogWriter !== undefined) {
      await this.auditLogWriter.write({
        actorUuid: userUuid,
        action: AuditAction.LoginSuccess,
        targetType: 'user',
        targetUuid: userUuid,
        ip: ipAddress ?? null,
      })
    }

    if (this.webhookDispatcher !== undefined) {
      try {
        await this.webhookDispatcher.dispatch(WebhookEvent.UserLogin, {
          userUuid,
          metadata: { result: 'success' },
        })
      } catch (error) {
        this.logger.error(`Could not dispatch user.login webhook: ${(error as Error).message}`)
      }
    }
  }

  private async recordLoginFailure(
    userUuid: string | null,
    email: string,
    ipAddress: string | null | undefined,
    reason: string,
  ): Promise<void> {
    if (this.auditLogWriter !== undefined) {
      await this.auditLogWriter.write({
        actorUuid: userUuid,
        action: AuditAction.LoginFailure,
        targetType: 'user',
        targetUuid: userUuid,
        ip: ipAddress ?? null,
        // email is the login identifier the user typed; not a secret.
        metadata: { email, reason },
      })
    }
  }

  private async validateCodeVerifier(codeVerifier: string): Promise<boolean> {
    const codeChallenge = this.crypter.base64URLEncode(this.crypter.sha256Hash(codeVerifier))

    const matchingCodeChallengeWasPresentAndRemoved = await this.pkceRepository.removeCodeChallenge(codeChallenge)

    return matchingCodeChallengeWasPresentAndRemoved
  }

  /**
   * Standard Red Notes: collapses an absent/empty workspace name to the
   * reserved 'default' workspace (matches the DB column default and the Register
   * / GetUserKeyParams use cases).
   */
  private normalizeWorkspaceIdentifier(requested?: string): string {
    const trimmed = (requested ?? '').trim()

    return trimmed.length === 0 ? 'default' : trimmed
  }

  private async sendSignInEmailNotification(user: User, userAgent: string): Promise<void> {
    try {
      await this.domainEventPublisher.publish(
        this.domainEventFactory.createEmailRequestedEvent({
          userEmail: user.email,
          level: EmailLevel.LEVELS.SignIn,
          body: getBody(
            user.email,
            this.sessionService.getOperatingSystemInfoFromUserAgent(userAgent),
            this.sessionService.getBrowserInfoFromUserAgent(userAgent),
            new Date(),
          ),
          messageIdentifier: 'SIGN_IN',
          subject: getSubject(user.email),
          userUuid: user.uuid,
        }),
      )
    } catch (error) {
      this.logger.error(`Could not publish sign in event: ${(error as Error).message}`)
    }
  }

  private async checkHumanVerificationIfNeeded(userIdentifier: string, hvmToken?: string): Promise<Result<void>> {
    const numberOfFailedAttempts = await this.lockRepository.getLockCounter(userIdentifier, 'non-captcha')
    const numberOfFailedAttemptsInCaptchaMode = await this.lockRepository.getLockCounter(userIdentifier, 'captcha')

    const isEligibleForNonCaptchaMode =
      numberOfFailedAttemptsInCaptchaMode === 0 && numberOfFailedAttempts < this.maxNonCaptchaAttempts

    if (isEligibleForNonCaptchaMode) {
      return Result.ok()
    }

    return this.verifyHumanInteractionUseCase.execute(hvmToken)
  }
}

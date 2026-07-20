import 'reflect-metadata'

import { DomainEventPublisherInterface, EmailRequestedEvent } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { AuthResponseFactoryInterface } from '../Auth/AuthResponseFactoryInterface'
import { AuthResponseFactoryResolverInterface } from '../Auth/AuthResponseFactoryResolverInterface'
import { DomainEventFactoryInterface } from '../Event/DomainEventFactoryInterface'
import { SessionServiceInterface } from '../Session/SessionServiceInterface'
import { User } from '../User/User'
import { UserRepositoryInterface } from '../User/UserRepositoryInterface'
import { SignIn } from './SignIn'
import { PKCERepositoryInterface } from '../User/PKCERepositoryInterface'
import { CrypterInterface } from '../Encryption/CrypterInterface'
import { ProtocolVersion } from '@standardnotes/common'
import { Session } from '../Session/Session'
import { LockRepositoryInterface } from '../User/LockRepositoryInterface'
import { VerifyHumanInteraction } from './VerifyHumanInteraction/VerifyHumanInteraction'
import { Result } from '@standardnotes/domain-core'

describe('SignIn', () => {
  let user: User
  let userRepository: UserRepositoryInterface
  let authResponseFactoryResolver: AuthResponseFactoryResolverInterface
  let authResponseFactory: AuthResponseFactoryInterface
  let domainEventPublisher: DomainEventPublisherInterface
  let domainEventFactory: DomainEventFactoryInterface
  let sessionService: SessionServiceInterface
  let logger: Logger
  let pkceRepository: PKCERepositoryInterface
  let crypter: CrypterInterface
  let session: Session
  let maxNonCaptchaAttempts: number
  let lockRepository: LockRepositoryInterface
  let verifyHumanInteractionUseCase: VerifyHumanInteraction

  const createUseCase = () =>
    new SignIn(
      userRepository,
      authResponseFactoryResolver,
      domainEventPublisher,
      domainEventFactory,
      sessionService,
      pkceRepository,
      crypter,
      logger,
      maxNonCaptchaAttempts,
      lockRepository,
      verifyHumanInteractionUseCase,
    )

  beforeEach(() => {
    user = {
      uuid: '1-2-3',
      email: 'test@test.com',
      version: ProtocolVersion.V004,
      isBanned: () => false,
      isAccessBlocked: () => false,
    } as unknown as jest.Mocked<User>
    user.encryptedPassword = '$2a$11$K3g6XoTau8VmLJcai1bB0eD9/YvBSBRtBhMprJOaVZ0U3SgasZH3a'

    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.findOneByUsernameOrEmail = jest.fn().mockReturnValue(user)
    userRepository.findOneByEmailAndWorkspaceIdentifier = jest.fn().mockReturnValue(user)

    session = {} as jest.Mocked<Session>
    authResponseFactory = {} as jest.Mocked<AuthResponseFactoryInterface>
    authResponseFactory.createResponse = jest.fn().mockReturnValue({ response: { foo: 'bar' }, session })

    authResponseFactoryResolver = {} as jest.Mocked<AuthResponseFactoryResolverInterface>
    authResponseFactoryResolver.resolveAuthResponseFactoryVersion = jest.fn().mockReturnValue(authResponseFactory)

    domainEventPublisher = {} as jest.Mocked<DomainEventPublisherInterface>
    domainEventPublisher.publish = jest.fn()

    domainEventFactory = {} as jest.Mocked<DomainEventFactoryInterface>
    domainEventFactory.createEmailRequestedEvent = jest.fn().mockReturnValue({} as jest.Mocked<EmailRequestedEvent>)

    sessionService = {} as jest.Mocked<SessionServiceInterface>
    sessionService.getOperatingSystemInfoFromUserAgent = jest.fn().mockReturnValue('iOS 1')
    sessionService.getBrowserInfoFromUserAgent = jest.fn().mockReturnValue('Firefox 1')

    pkceRepository = {} as jest.Mocked<PKCERepositoryInterface>
    pkceRepository.removeCodeChallenge = jest.fn().mockReturnValue(true)

    crypter = {} as jest.Mocked<CrypterInterface>
    crypter.base64URLEncode = jest.fn().mockReturnValue('base64-url-encoded')
    crypter.sha256Hash = jest.fn().mockReturnValue('sha256-hashed')

    logger = {} as jest.Mocked<Logger>
    logger.debug = jest.fn()
    logger.error = jest.fn()

    lockRepository = {} as jest.Mocked<LockRepositoryInterface>
    lockRepository.getLockCounter = jest.fn().mockReturnValue(0)

    maxNonCaptchaAttempts = 6
  })

  it('should fail sign in a legacy user without code verifier', async () => {
    pkceRepository.removeCodeChallenge = jest.fn().mockReturnValue(false)

    user.version = ProtocolVersion.V003
    userRepository.findOneByUsernameOrEmail = jest.fn().mockReturnValue(user)

    expect(
      await createUseCase().execute({
        email: 'test@test.te',
        password: 'qweqwe123123',
        userAgent: 'Google Chrome',
        apiVersion: '20190520',
        ephemeralSession: false,
        codeVerifier: '',
      }),
    ).toEqual({
      success: false,
      errorCode: 410,
      errorMessage: 'Please update your client application.',
    })
  })

  it('should not sign in 004 user without code verifier', async () => {
    pkceRepository.removeCodeChallenge = jest.fn().mockReturnValue(false)

    expect(
      await createUseCase().execute({
        email: 'test@test.te',
        password: 'qweqwe123123',
        userAgent: 'Google Chrome',
        apiVersion: '20190520',
        ephemeralSession: false,
        codeVerifier: '',
      }),
    ).toEqual({
      success: false,
      errorCode: 410,
      errorMessage: 'Please update your client application.',
    })
  })

  it('should not sign in 005 user without code verifier', async () => {
    pkceRepository.removeCodeChallenge = jest.fn().mockReturnValue(false)

    user = {
      uuid: '1-2-3',
      email: 'test@test.com',
      version: '005',
    } as jest.Mocked<User>

    expect(
      await createUseCase().execute({
        email: 'test@test.te',
        password: 'qweqwe123123',
        userAgent: 'Google Chrome',
        apiVersion: '20190520',
        ephemeralSession: false,
        codeVerifier: '',
      }),
    ).toEqual({
      success: false,
      errorCode: 410,
      errorMessage: 'Please update your client application.',
    })
  })

  it('should not sign in a user with invalid username', async () => {
    expect(
      await createUseCase().execute({
        email: '  ',
        password: 'qweqwe123123',
        userAgent: 'Google Chrome',
        apiVersion: '20190520',
        ephemeralSession: false,
        codeVerifier: 'test',
      }),
    ).toEqual({
      success: false,
      errorMessage: 'Username cannot be empty',
    })

    expect(domainEventFactory.createEmailRequestedEvent).not.toHaveBeenCalled()
    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
  })

  it('should not sign in a user with invalid api version', async () => {
    expect(
      await createUseCase().execute({
        email: 'test@test.te',
        password: 'qweqwe123123',
        userAgent: 'Google Chrome',
        apiVersion: 'invalid',
        ephemeralSession: false,
        codeVerifier: 'test',
      }),
    ).toEqual({
      success: false,
      errorMessage: 'Invalid api version: invalid',
    })

    expect(domainEventFactory.createEmailRequestedEvent).not.toHaveBeenCalled()
    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
  })

  it('should sign in a user with valid code verifier', async () => {
    expect(
      await createUseCase().execute({
        email: 'test@test.te',
        password: 'qweqwe123123',
        userAgent: 'Google Chrome',
        apiVersion: '20190520',
        ephemeralSession: false,
        codeVerifier: 'test',
      }),
    ).toEqual({
      success: true,
      result: {
        response: { foo: 'bar' },
        session,
      },
    })

    expect(domainEventFactory.createEmailRequestedEvent).toHaveBeenCalled()
    expect(domainEventPublisher.publish).toHaveBeenCalled()
  })

  it('should sign in a user even if publishing a sign in event fails', async () => {
    domainEventPublisher.publish = jest.fn().mockImplementation(() => {
      throw new Error('Oops')
    })

    expect(
      await createUseCase().execute({
        email: 'test@test.te',
        password: 'qweqwe123123',
        userAgent: 'Google Chrome',
        apiVersion: '20190520',
        ephemeralSession: false,
        codeVerifier: 'test',
      }),
    ).toEqual({
      success: true,
      result: {
        response: { foo: 'bar' },
        session,
      },
    })
  })

  it('should not sign in a user with wrong credentials', async () => {
    expect(
      await createUseCase().execute({
        email: 'test@test.te',
        password: 'asdasd123123',
        userAgent: 'Google Chrome',
        apiVersion: '20190520',
        ephemeralSession: false,
        codeVerifier: 'test',
      }),
    ).toEqual({
      success: false,
      errorMessage: 'Invalid email or password',
    })
  })

  it('should not sign in a banned user even with valid credentials', async () => {
    user = {
      uuid: '1-2-3',
      email: 'test@test.com',
      version: ProtocolVersion.V004,
      isBanned: () => true,
      isSuspended: () => false,
      isPendingApproval: () => false,
      isAccessBlocked: () => true,
    } as unknown as jest.Mocked<User>
    user.encryptedPassword = '$2a$11$K3g6XoTau8VmLJcai1bB0eD9/YvBSBRtBhMprJOaVZ0U3SgasZH3a'
    userRepository.findOneByUsernameOrEmail = jest.fn().mockReturnValue(user)

    expect(
      await createUseCase().execute({
        email: 'test@test.te',
        password: 'qweqwe123123',
        userAgent: 'Google Chrome',
        apiVersion: '20190520',
        ephemeralSession: false,
        codeVerifier: 'test',
      }),
    ).toEqual({
      success: false,
      errorCode: 403,
      errorMessage: 'This account has been suspended. Please contact an administrator.',
    })

    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
  })

  // Standard Red Notes: suspension is folded into isAccessBlocked, so a
  // suspended user is rejected at sign-in exactly like a hard-banned one.
  it('should not sign in a suspended user even with valid credentials', async () => {
    user = {
      uuid: '1-2-3',
      email: 'test@test.com',
      version: ProtocolVersion.V004,
      isBanned: () => false,
      isSuspended: () => true,
      isPendingApproval: () => false,
      isAccessBlocked: () => true,
    } as unknown as jest.Mocked<User>
    user.encryptedPassword = '$2a$11$K3g6XoTau8VmLJcai1bB0eD9/YvBSBRtBhMprJOaVZ0U3SgasZH3a'
    userRepository.findOneByUsernameOrEmail = jest.fn().mockReturnValue(user)

    expect(
      await createUseCase().execute({
        email: 'test@test.te',
        password: 'qweqwe123123',
        userAgent: 'Google Chrome',
        apiVersion: '20190520',
        ephemeralSession: false,
        codeVerifier: 'test',
      }),
    ).toEqual({
      success: false,
      errorCode: 403,
      errorMessage: 'This account has been suspended. Please contact an administrator.',
    })

    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
  })

  // Standard Red Notes: APPROVAL QUEUE — a pending (approved=false) user is folded
  // into isAccessBlocked and gets the friendly "awaiting approval" message.
  it('should not sign in a pending-approval user, with a friendly message', async () => {
    user = {
      uuid: '1-2-3',
      email: 'test@test.com',
      version: ProtocolVersion.V004,
      isBanned: () => false,
      isSuspended: () => false,
      isPendingApproval: () => true,
      isAccessBlocked: () => true,
    } as unknown as jest.Mocked<User>
    user.encryptedPassword = '$2a$11$K3g6XoTau8VmLJcai1bB0eD9/YvBSBRtBhMprJOaVZ0U3SgasZH3a'
    userRepository.findOneByUsernameOrEmail = jest.fn().mockReturnValue(user)

    expect(
      await createUseCase().execute({
        email: 'test@test.te',
        password: 'qweqwe123123',
        userAgent: 'Google Chrome',
        apiVersion: '20190520',
        ephemeralSession: false,
        codeVerifier: 'test',
      }),
    ).toEqual({
      success: false,
      errorCode: 403,
      errorMessage: 'Your account is awaiting administrator approval.',
    })

    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
  })

  it('should not sign in a user with invalid code verifier', async () => {
    pkceRepository.removeCodeChallenge = jest.fn().mockReturnValue(false)

    expect(
      await createUseCase().execute({
        email: 'test@test.te',
        password: 'qweqwe123123',
        userAgent: 'Google Chrome',
        apiVersion: '20190520',
        ephemeralSession: false,
        codeVerifier: 'test',
      }),
    ).toEqual({
      success: false,
      errorMessage: 'Invalid email or password',
    })
  })

  it('should not sign in a user that does not exist', async () => {
    userRepository.findOneByUsernameOrEmail = jest.fn().mockReturnValue(null)

    expect(
      await createUseCase().execute({
        email: 'test@test.te',
        password: 'asdasd123123',
        userAgent: 'Google Chrome',
        apiVersion: '20190520',
        ephemeralSession: false,
        codeVerifier: 'test',
      }),
    ).toEqual({
      success: false,
      errorMessage: 'Invalid email or password',
    })
  })

  it('should sign in a user with valid code verifier and invalid hvm token but not requiring human verification', async () => {
    verifyHumanInteractionUseCase = {} as jest.Mocked<VerifyHumanInteraction>
    verifyHumanInteractionUseCase.execute = jest
      .fn()
      .mockReturnValueOnce(Result.fail('Human verification step failed.'))

    expect(
      await createUseCase().execute({
        email: 'test@test.te',
        password: 'qweqwe123123',
        userAgent: 'Google Chrome',
        apiVersion: '20190520',
        ephemeralSession: false,
        codeVerifier: 'test',
      }),
    ).toEqual({
      success: true,
      result: {
        response: { foo: 'bar' },
        session,
      },
    })
  })

  it('should sign in a user with valid code verifier and valid hvm token requiring human verification', async () => {
    lockRepository.getLockCounter = jest.fn().mockReturnValueOnce(maxNonCaptchaAttempts)
    verifyHumanInteractionUseCase = {} as jest.Mocked<VerifyHumanInteraction>
    verifyHumanInteractionUseCase.execute = jest.fn().mockReturnValueOnce(Result.ok())

    expect(
      await createUseCase().execute({
        email: 'test@test.te',
        password: 'qweqwe123123',
        userAgent: 'Google Chrome',
        apiVersion: '20190520',
        ephemeralSession: false,
        codeVerifier: 'test',
        hvmToken: 'foobar',
      }),
    ).toEqual({
      success: true,
      result: {
        response: { foo: 'bar' },
        session,
      },
    })
  })

  it('should not sign in a user with valid code verifier and invalid hvm token requiring human verification', async () => {
    lockRepository.getLockCounter = jest.fn().mockReturnValueOnce(maxNonCaptchaAttempts)
    verifyHumanInteractionUseCase = {} as jest.Mocked<VerifyHumanInteraction>
    verifyHumanInteractionUseCase.execute = jest
      .fn()
      .mockReturnValueOnce(Result.fail('Human verification step failed.'))

    expect(
      await createUseCase().execute({
        email: 'test@test.te',
        password: 'qweqwe123123',
        userAgent: 'Google Chrome',
        apiVersion: '20190520',
        ephemeralSession: false,
        codeVerifier: 'test',
        hvmToken: 'foobar',
      }),
    ).toEqual({
      success: false,
      errorMessage: 'Human verification step failed.',
    })
  })

  describe('Standard Red Notes: workspaces per email (WORKSPACES_PER_EMAIL_ENABLED)', () => {
    const createUseCaseWithWorkspaces = () =>
      new SignIn(
        userRepository,
        authResponseFactoryResolver,
        domainEventPublisher,
        domainEventFactory,
        sessionService,
        pkceRepository,
        crypter,
        logger,
        maxNonCaptchaAttempts,
        lockRepository,
        verifyHumanInteractionUseCase,
        true,
      )

    it('flag OFF: resolves by email only (composite lookup is not used)', async () => {
      await createUseCase().execute({
        email: 'test@test.te',
        password: 'qweqwe123123',
        userAgent: 'Google Chrome',
        apiVersion: '20190520',
        ephemeralSession: false,
        codeVerifier: 'test',
        workspaceIdentifier: 'team-a',
      })

      expect(userRepository.findOneByUsernameOrEmail).toHaveBeenCalled()
      expect(userRepository.findOneByEmailAndWorkspaceIdentifier).not.toHaveBeenCalled()
    })

    it('flag ON: resolves the account by the composite (email, workspace) before verifying the password', async () => {
      const result = await createUseCaseWithWorkspaces().execute({
        email: 'test@test.te',
        password: 'qweqwe123123',
        userAgent: 'Google Chrome',
        apiVersion: '20190520',
        ephemeralSession: false,
        codeVerifier: 'test',
        workspaceIdentifier: 'team-a',
      })

      expect(userRepository.findOneByEmailAndWorkspaceIdentifier).toHaveBeenCalledWith(
        expect.objectContaining({ value: 'test@test.te' }),
        'team-a',
      )
      expect(result.success).toBe(true)
    })

    it("flag ON: an absent workspace name targets the 'default' workspace", async () => {
      await createUseCaseWithWorkspaces().execute({
        email: 'test@test.te',
        password: 'qweqwe123123',
        userAgent: 'Google Chrome',
        apiVersion: '20190520',
        ephemeralSession: false,
        codeVerifier: 'test',
      })

      expect(userRepository.findOneByEmailAndWorkspaceIdentifier).toHaveBeenCalledWith(
        expect.objectContaining({ value: 'test@test.te' }),
        'default',
      )
    })

    it('flag ON: a non-matching (email, workspace) pair fails with the generic invalid-credentials message', async () => {
      userRepository.findOneByEmailAndWorkspaceIdentifier = jest.fn().mockReturnValue(null)

      const result = await createUseCaseWithWorkspaces().execute({
        email: 'test@test.te',
        password: 'qweqwe123123',
        userAgent: 'Google Chrome',
        apiVersion: '20190520',
        ephemeralSession: false,
        codeVerifier: 'test',
        workspaceIdentifier: 'does-not-exist',
      })

      expect(result).toEqual({
        success: false,
        errorMessage: 'Invalid email or password',
      })
    })
  })

  describe('email confirmation gate (Standard Red Notes)', () => {
    let registrationConfigResolver: { resolve: jest.Mock }

    const baseConfig = {
      defaultRole: 'CORE_USER',
      domainMode: 'off' as const,
      domainList: [] as string[],
      emailConfirmationEnabled: false,
      emailConfirmationGating: 'block_signin' as const,
      emailConfirmationSubject: 's',
      emailConfirmationBody: 'b',
      emailConfirmationBaseUrl: '',
    }

    const createUseCaseWithGate = () =>
      new SignIn(
        userRepository,
        authResponseFactoryResolver,
        domainEventPublisher,
        domainEventFactory,
        sessionService,
        pkceRepository,
        crypter,
        logger,
        maxNonCaptchaAttempts,
        lockRepository,
        verifyHumanInteractionUseCase,
        false,
        undefined,
        undefined,
        registrationConfigResolver as never,
      )

    const signIn = () =>
      createUseCaseWithGate().execute({
        email: 'test@test.te',
        password: 'qweqwe123123',
        userAgent: 'Google Chrome',
        apiVersion: '20190520',
        ephemeralSession: false,
        codeVerifier: 'test',
      })

    beforeEach(() => {
      registrationConfigResolver = { resolve: jest.fn() }
      user.isEmailConfirmed = jest.fn().mockReturnValue(false)
      userRepository.findOneByUsernameOrEmail = jest.fn().mockReturnValue(user)
    })

    it('BLOCKS an unconfirmed user when enabled + gating is block_signin', async () => {
      registrationConfigResolver.resolve.mockResolvedValue({ ...baseConfig, emailConfirmationEnabled: true })

      const result = (await signIn()) as { success: boolean; errorCode?: number; errorMessage?: string }

      expect(result.success).toBe(false)
      expect(result.errorCode).toBe(403)
      expect(result.errorMessage).toMatch(/confirm your email/i)
    })

    it('ALLOWS an unconfirmed user when the feature is disabled', async () => {
      registrationConfigResolver.resolve.mockResolvedValue({ ...baseConfig, emailConfirmationEnabled: false })

      const result = await signIn()

      expect(result.success).toBe(true)
    })

    it('ALLOWS an unconfirmed user in warn mode', async () => {
      registrationConfigResolver.resolve.mockResolvedValue({
        ...baseConfig,
        emailConfirmationEnabled: true,
        emailConfirmationGating: 'warn',
      })

      const result = await signIn()

      expect(result.success).toBe(true)
    })

    it('ALLOWS a CONFIRMED user even when block_signin is enabled', async () => {
      user.isEmailConfirmed = jest.fn().mockReturnValue(true)
      registrationConfigResolver.resolve.mockResolvedValue({ ...baseConfig, emailConfirmationEnabled: true })

      const result = await signIn()

      expect(result.success).toBe(true)
    })

    it('does not block when the resolver throws (fails open)', async () => {
      registrationConfigResolver.resolve.mockRejectedValue(new Error('overlay unreadable'))

      const result = await signIn()

      expect(result.success).toBe(true)
    })
  })

  describe('audit log and webhook hooks', () => {
    let auditLogWriter: { write: jest.Mock }
    let webhookDispatcher: { dispatch: jest.Mock }

    const createUseCaseWithHooks = () =>
      new SignIn(
        userRepository,
        authResponseFactoryResolver,
        domainEventPublisher,
        domainEventFactory,
        sessionService,
        pkceRepository,
        crypter,
        logger,
        maxNonCaptchaAttempts,
        lockRepository,
        verifyHumanInteractionUseCase,
        false,
        auditLogWriter as never,
        webhookDispatcher as never,
      )

    const signIn = (password: string, ipAddress?: string | null) =>
      createUseCaseWithHooks().execute({
        email: 'test@test.te',
        password,
        userAgent: 'Google Chrome',
        apiVersion: '20190520',
        ephemeralSession: false,
        codeVerifier: 'test',
        ipAddress,
      } as never)

    beforeEach(() => {
      auditLogWriter = { write: jest.fn().mockResolvedValue(undefined) }
      webhookDispatcher = { dispatch: jest.fn().mockResolvedValue(undefined) }
    })

    it('records a login.success audit entry and dispatches the user.login webhook', async () => {
      const result = await signIn('qweqwe123123', '203.0.113.9')

      expect(result.success).toBe(true)
      expect(auditLogWriter.write).toHaveBeenCalledWith({
        actorUuid: '1-2-3',
        action: 'login.success',
        targetType: 'user',
        targetUuid: '1-2-3',
        ip: '203.0.113.9',
      })
      expect(webhookDispatcher.dispatch).toHaveBeenCalledWith('user.login', {
        userUuid: '1-2-3',
        metadata: { result: 'success' },
      })
    })

    it('normalizes a missing ip address to null on the audit entry', async () => {
      await signIn('qweqwe123123')

      expect(auditLogWriter.write).toHaveBeenCalledWith(expect.objectContaining({ ip: null }))
    })

    it('records a login.failure audit entry with the reason and does not fire the webhook', async () => {
      const result = await signIn('wrong-password', '203.0.113.9')

      expect(result.success).toBe(false)
      expect(auditLogWriter.write).toHaveBeenCalledWith({
        actorUuid: '1-2-3',
        action: 'login.failure',
        targetType: 'user',
        targetUuid: '1-2-3',
        ip: '203.0.113.9',
        metadata: { email: 'test@test.te', reason: 'invalid_password' },
      })
      expect(webhookDispatcher.dispatch).not.toHaveBeenCalled()
    })

    it('still signs the user in when the webhook dispatcher throws', async () => {
      webhookDispatcher.dispatch = jest.fn().mockRejectedValue(new Error('endpoint unreachable'))

      const result = await signIn('qweqwe123123')

      expect(result.success).toBe(true)
      expect(logger.error).toHaveBeenCalledWith('Could not dispatch user.login webhook: endpoint unreachable')
    })

    it('signs in without touching either hook when neither is configured', async () => {
      const result = await createUseCase().execute({
        email: 'test@test.te',
        password: 'qweqwe123123',
        userAgent: 'Google Chrome',
        apiVersion: '20190520',
        ephemeralSession: false,
        codeVerifier: 'test',
      })

      expect(result.success).toBe(true)
      expect(auditLogWriter.write).not.toHaveBeenCalled()
      expect(webhookDispatcher.dispatch).not.toHaveBeenCalled()
    })
  })
})

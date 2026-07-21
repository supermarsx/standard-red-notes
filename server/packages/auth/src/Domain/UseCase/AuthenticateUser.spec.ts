import 'reflect-metadata'

import { Session } from '../Session/Session'

import { User } from '../User/User'
import { AuthenticateUser } from './AuthenticateUser'
import { RevokedSession } from '../Session/RevokedSession'
import { AuthenticationMethodResolverInterface } from '../Auth/AuthenticationMethodResolverInterface'
import { TimerInterface } from '@standardnotes/time'
import { Logger } from 'winston'

describe('AuthenticateUser', () => {
  let user: User
  let session: Session
  let revokedSession: RevokedSession
  let authenticationMethodResolver: AuthenticationMethodResolverInterface
  let timer: TimerInterface
  let logger: Logger
  const accessTokenAge = 3600

  const createUseCase = () => new AuthenticateUser(authenticationMethodResolver, timer, accessTokenAge, logger)

  beforeEach(() => {
    logger = {} as jest.Mocked<Logger>
    logger.debug = jest.fn()
    logger.error = jest.fn()
    logger.warn = jest.fn()

    user = {} as jest.Mocked<User>
    user.supportsSessions = jest.fn().mockReturnValue(false)
    user.isBanned = jest.fn().mockReturnValue(false)
    user.isAccessBlocked = jest.fn().mockReturnValue(false)

    session = {} as jest.Mocked<Session>
    session.accessExpiration = new Date(123)
    session.refreshExpiration = new Date(234)

    revokedSession = {} as jest.Mocked<RevokedSession>
    revokedSession.uuid = '1-2-3'

    authenticationMethodResolver = {} as jest.Mocked<AuthenticationMethodResolverInterface>
    authenticationMethodResolver.resolve = jest.fn()

    timer = {} as jest.Mocked<TimerInterface>
    timer.getUTCDate = jest.fn().mockReturnValue(new Date(100))
    timer.getUTCDateNSecondsAhead = jest.fn().mockReturnValue(new Date(100 + accessTokenAge))
  })

  it('should authenticate a user based on a JWT token', async () => {
    user.encryptedPassword = 'test'

    authenticationMethodResolver.resolve = jest.fn().mockReturnValue({
      type: 'jwt',
      claims: {
        pw_hash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      },
      user,
    })

    const response = await createUseCase().execute({
      authTokenFromHeaders: 'test',
      requestMetadata: { url: '/foobar', method: 'GET' },
    })

    expect(response.success).toBeTruthy()
  })

  it('should not authenticate a banned user', async () => {
    user.encryptedPassword = 'test'
    user.isBanned = jest.fn().mockReturnValue(true)
    user.isAccessBlocked = jest.fn().mockReturnValue(true)

    authenticationMethodResolver.resolve = jest.fn().mockReturnValue({
      type: 'jwt',
      claims: {
        pw_hash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      },
      user,
    })

    const response = await createUseCase().execute({
      authTokenFromHeaders: 'test',
      requestMetadata: { url: '/foobar', method: 'GET' },
    })

    expect(response.success).toBeFalsy()
    expect((response as { failureType?: string }).failureType).toEqual('INVALID_AUTH')
  })

  // Standard Red Notes: suspension is folded into isAccessBlocked, so an
  // already-signed-in suspended user loses access on their next authenticated
  // request exactly like a hard-banned one.
  it('should not authenticate a suspended user', async () => {
    user.encryptedPassword = 'test'
    user.isBanned = jest.fn().mockReturnValue(false)
    user.isAccessBlocked = jest.fn().mockReturnValue(true)

    authenticationMethodResolver.resolve = jest.fn().mockReturnValue({
      type: 'jwt',
      claims: {
        pw_hash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      },
      user,
    })

    const response = await createUseCase().execute({
      authTokenFromHeaders: 'test',
      requestMetadata: { url: '/foobar', method: 'GET' },
    })

    expect(response.success).toBeFalsy()
    expect((response as { failureType?: string }).failureType).toEqual('INVALID_AUTH')
  })

  it('should not authenticate a user if the password hashed in JWT token is inavlid', async () => {
    user.encryptedPassword = 'test2'

    authenticationMethodResolver.resolve = jest.fn().mockReturnValue({
      type: 'jwt',
      claims: {
        pw_hash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      },
      user,
    })

    const response = await createUseCase().execute({
      authTokenFromHeaders: 'test',
      requestMetadata: { url: '/foobar', method: 'GET' },
    })

    expect(response.success).toBeFalsy()
  })

  it('should not authenticate a user if the user is from JWT token is not found', async () => {
    authenticationMethodResolver.resolve = jest.fn().mockReturnValue({
      type: 'jwt',
      claims: {
        pw_hash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      },
    })

    const response = await createUseCase().execute({
      authTokenFromHeaders: 'test',
      requestMetadata: { url: '/foobar', method: 'GET' },
    })

    expect(response.success).toBeFalsy()
  })

  it('should not authenticate a user if the user from JWT token supports sessions', async () => {
    user.supportsSessions = jest.fn().mockReturnValue(true)

    authenticationMethodResolver.resolve = jest.fn().mockReturnValue({
      type: 'jwt',
      claims: {
        pw_hash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      },
      user,
    })

    const response = await createUseCase().execute({
      authTokenFromHeaders: 'test',
      requestMetadata: { url: '/foobar', method: 'GET' },
    })

    expect(response.success).toBeFalsy()
  })

  it('should authenticate a user from a session token', async () => {
    user.supportsSessions = jest.fn().mockReturnValue(true)

    authenticationMethodResolver.resolve = jest.fn().mockReturnValue({
      type: 'session_token',
      session,
      user,
    })

    const response = await createUseCase().execute({
      authTokenFromHeaders: 'test',
      requestMetadata: { url: '/foobar', method: 'GET' },
    })

    expect(response.success).toBeTruthy()
  })

  it('should not authenticate a user from a session token that is in cooldown', async () => {
    user.supportsSessions = jest.fn().mockReturnValue(true)

    authenticationMethodResolver.resolve = jest.fn().mockReturnValue({
      type: 'session_token',
      session,
      user,
      givenTokensWereInCooldown: true,
    })

    const response = await createUseCase().execute({
      authTokenFromHeaders: 'test',
      requestMetadata: { url: '/foobar', method: 'GET' },
    })

    expect(response.success).toBeFalsy()
    expect(response.failureType).toEqual('COOLEDDOWN_TOKEN')
  })

  it('should omit the client hint from the cooldown warning when the session has no user agent', async () => {
    user.uuid = '1-2-3'
    user.supportsSessions = jest.fn().mockReturnValue(true)
    session.uuid = '2-3-4'
    session.userAgent = undefined as unknown as string

    authenticationMethodResolver.resolve = jest.fn().mockReturnValue({
      type: 'session_token',
      session,
      user,
      givenTokensWereInCooldown: true,
    })

    await createUseCase().execute({
      authTokenFromHeaders: 'test',
      requestMetadata: { url: '/foobar', method: 'GET', secChUa: 'Chromium;v=124' },
    })

    expect(logger.warn).toHaveBeenCalledWith(
      'Request was authenticated with tokens that were in cooldown.',
      expect.objectContaining({ userAgent: undefined, secChUa: undefined }),
    )
  })

  it('should include the client hint in the cooldown warning when the session has a user agent', async () => {
    user.uuid = '1-2-3'
    user.supportsSessions = jest.fn().mockReturnValue(true)
    session.uuid = '2-3-4'
    session.userAgent = 'Mozilla/5.0'

    authenticationMethodResolver.resolve = jest.fn().mockReturnValue({
      type: 'session_token',
      session,
      user,
      givenTokensWereInCooldown: true,
    })

    await createUseCase().execute({
      authTokenFromHeaders: 'test',
      requestMetadata: {
        url: '/foobar',
        method: 'GET',
        secChUa: 'Chromium;v=124',
        snjs: '2.0.0',
        application: 'web',
      },
    })

    expect(logger.warn).toHaveBeenCalledWith('Request was authenticated with tokens that were in cooldown.', {
      userId: '1-2-3',
      sessionUuid: '2-3-4',
      snjs: '2.0.0',
      application: 'web',
      url: '/foobar',
      method: 'GET',
      userAgent: 'Mozilla/5.0',
      secChUa: 'Chromium;v=124',
    })
  })

  it('should not authenticate a user from a session token if session is expired', async () => {
    timer.getUTCDate = jest.fn().mockReturnValue(new Date(200))
    user.supportsSessions = jest.fn().mockReturnValue(true)

    authenticationMethodResolver.resolve = jest.fn().mockReturnValue({
      type: 'session_token',
      session,
      user,
    })

    const response = await createUseCase().execute({
      authTokenFromHeaders: 'test',
      requestMetadata: { url: '/foobar', method: 'GET' },
    })

    expect(response.success).toBeFalsy()
  })

  it('should not authenticate a user from a session token if session is longer than configured', async () => {
    timer.getUTCDateNSecondsAhead = jest.fn().mockReturnValue(new Date(20))
    user.supportsSessions = jest.fn().mockReturnValue(true)

    authenticationMethodResolver.resolve = jest.fn().mockReturnValue({
      type: 'session_token',
      session,
      user,
    })

    const response = await createUseCase().execute({
      authTokenFromHeaders: 'test',
      requestMetadata: { url: '/foobar', method: 'GET' },
    })

    expect(response.success).toBeFalsy()
  })

  it('should not authenticate a user from a session token if refresh token is expired', async () => {
    timer.getUTCDate = jest.fn().mockReturnValue(new Date(500))
    user.supportsSessions = jest.fn().mockReturnValue(true)

    authenticationMethodResolver.resolve = jest.fn().mockReturnValue({
      type: 'session_token',
      session,
      user,
    })

    const response = await createUseCase().execute({
      authTokenFromHeaders: 'test',
      requestMetadata: { url: '/foobar', method: 'GET' },
    })

    expect(response.success).toBeFalsy()
  })

  it('should not authenticate a user from a session token if session is not found', async () => {
    user.supportsSessions = jest.fn().mockReturnValue(true)

    authenticationMethodResolver.resolve = jest.fn().mockReturnValue({
      type: 'session_token',
      user,
    })

    const response = await createUseCase().execute({
      authTokenFromHeaders: 'test',
      requestMetadata: { url: '/foobar', method: 'GET' },
    })

    expect(response.success).toBeFalsy()
  })

  it('should not authenticate a user if a session is revoked', async () => {
    authenticationMethodResolver.resolve = jest.fn().mockReturnValue({
      type: 'revoked',
      revokedSession,
    })

    const response = await createUseCase().execute({
      authTokenFromHeaders: 'test',
      requestMetadata: { url: '/foobar', method: 'GET' },
    })

    expect(response.success).toBeFalsy()
    expect(response.failureType).toEqual('REVOKED_SESSION')
  })

  it('should not authenticate a user if authentication method could not be determined', async () => {
    authenticationMethodResolver.resolve = jest.fn().mockReturnValue(undefined)

    const response = await createUseCase().execute({
      authTokenFromHeaders: 'test',
      requestMetadata: { url: '/foobar', method: 'GET' },
    })

    expect(response.success).toBeFalsy()
  })
})

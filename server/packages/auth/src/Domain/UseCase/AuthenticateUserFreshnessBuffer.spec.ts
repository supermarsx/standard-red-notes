import 'reflect-metadata'

import { TimerInterface } from '@standardnotes/time'
import { Logger } from 'winston'

import { Session } from '../Session/Session'
import { User } from '../User/User'
import { AuthenticationMethodResolverInterface } from '../Auth/AuthenticationMethodResolverInterface'

import { AuthenticateUser } from './AuthenticateUser'

/**
 * Verifies that the configurable session-freshness buffer (SESSION_FRESHNESS_BUFFER)
 * flows through to the "longer than current configuration" check. The default of 10
 * preserves the previously hardcoded behavior; an operator-set value must be honored.
 */
describe('AuthenticateUser - session freshness buffer', () => {
  let user: User
  let session: Session
  let authenticationMethodResolver: AuthenticationMethodResolverInterface
  let timer: TimerInterface
  let logger: Logger

  const accessTokenAge = 3600

  const createUseCase = (freshnessBufferSeconds?: number) =>
    freshnessBufferSeconds === undefined
      ? new AuthenticateUser(authenticationMethodResolver, timer, accessTokenAge, logger)
      : new AuthenticateUser(authenticationMethodResolver, timer, accessTokenAge, logger, freshnessBufferSeconds)

  beforeEach(() => {
    logger = {} as jest.Mocked<Logger>
    logger.debug = jest.fn()
    logger.error = jest.fn()
    logger.warn = jest.fn()

    user = {} as jest.Mocked<User>
    user.supportsSessions = jest.fn().mockReturnValue(true)
    user.isBanned = jest.fn().mockReturnValue(false)

    session = {} as jest.Mocked<Session>
    session.accessExpiration = new Date(123)
    session.refreshExpiration = new Date(234)

    authenticationMethodResolver = {} as jest.Mocked<AuthenticationMethodResolverInterface>
    authenticationMethodResolver.resolve = jest.fn().mockReturnValue({
      type: 'session_token',
      session,
      user,
    })

    timer = {} as jest.Mocked<TimerInterface>
    timer.getUTCDate = jest.fn().mockReturnValue(new Date(100))
    timer.getUTCDateNSecondsAhead = jest.fn().mockReturnValue(new Date(1_000_000))
  })

  it('should default the freshness buffer to 10 seconds (preserving prior behavior)', async () => {
    await createUseCase().execute({
      authTokenFromHeaders: 'test',
      requestMetadata: { url: '/foobar', method: 'GET' },
    })

    expect(timer.getUTCDateNSecondsAhead).toHaveBeenCalledWith(accessTokenAge + 10)
  })

  it('should honor an operator-configured freshness buffer', async () => {
    await createUseCase(45).execute({
      authTokenFromHeaders: 'test',
      requestMetadata: { url: '/foobar', method: 'GET' },
    })

    expect(timer.getUTCDateNSecondsAhead).toHaveBeenCalledWith(accessTokenAge + 45)
  })
})

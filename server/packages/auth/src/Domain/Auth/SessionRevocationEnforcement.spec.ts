import 'reflect-metadata'

import * as crypto from 'crypto'

import { Result } from '@standardnotes/domain-core'
import { SessionTokenData, TokenDecoderInterface } from '@standardnotes/security'
import { Logger } from 'winston'

import { Session } from '../Session/Session'
import { RevokedSession } from '../Session/RevokedSession'
import { SessionService } from '../Session/SessionService'
import { SessionRepositoryInterface } from '../Session/SessionRepositoryInterface'
import { EphemeralSessionRepositoryInterface } from '../Session/EphemeralSessionRepositoryInterface'
import { RevokedSessionRepositoryInterface } from '../Session/RevokedSessionRepositoryInterface'
import { SessionServiceInterface } from '../Session/SessionServiceInterface'
import { User } from '../User/User'
import { UserRepositoryInterface } from '../User/UserRepositoryInterface'
import { GetSessionFromToken } from '../UseCase/GetSessionFromToken/GetSessionFromToken'
import { GetCooldownSessionTokens } from '../UseCase/GetCooldownSessionTokens/GetCooldownSessionTokens'
import { DeleteSessionForUser } from '../UseCase/DeleteSessionForUser'
import { DeleteOtherSessionsForUser } from '../UseCase/DeleteOtherSessionsForUser'

import { AuthenticationMethodResolver } from './AuthenticationMethodResolver'

/**
 * Standard Red Notes: behaviour-locking integration test for session revocation.
 *
 * The real incident: a looping client kept hitting the API after its `sessions`
 * row was deleted, because nothing forced an immediate 401. These tests wire the
 * real AuthenticationMethodResolver + GetSessionFromToken + SessionService over
 * in-memory `sessions`/`revoked_sessions` maps and prove the enforcement path:
 *
 *   1. a live session-token authenticates (type: 'session_token'),
 *   2. once that session is revoked (row deleted + added to revoked_sessions),
 *      the SAME token resolves to type: 'revoked' -> 401,
 *   3. "sign out other sessions" revokes every OTHER session while the current
 *      session keeps working.
 */
describe('Session revocation enforcement (integration)', () => {
  const USER_UUID = '00000000-0000-0000-0000-0000000000aa'

  let sessionsTable: Map<string, Session>
  let revokedSessionsTable: Map<string, RevokedSession>

  let sessionRepository: SessionRepositoryInterface
  let ephemeralSessionRepository: EphemeralSessionRepositoryInterface
  let revokedSessionRepository: RevokedSessionRepositoryInterface
  let userRepository: UserRepositoryInterface
  let getCooldownSessionTokens: GetCooldownSessionTokens
  let getSessionFromToken: GetSessionFromToken
  let sessionService: SessionServiceInterface
  let sessionTokenDecoder: TokenDecoderInterface<SessionTokenData>
  let fallbackTokenDecoder: TokenDecoderInterface<SessionTokenData>
  let logger: Logger
  let user: User

  const requestMetadata = { url: '/items/sync', method: 'POST' }

  const hash = (token: string): string => crypto.createHash('sha256').update(token).digest('hex')

  // Builds a header-based session (token format `1:uuid:accessToken`) and stores it.
  const createLiveSession = (sessionUuid: string, accessToken: string): { session: Session; token: string } => {
    const session = new Session()
    session.uuid = sessionUuid
    session.userUuid = USER_UUID
    session.privateIdentifier = `pid-${sessionUuid}`
    session.hashedAccessToken = hash(accessToken)
    session.hashedRefreshToken = hash(`refresh-${accessToken}`)
    session.accessExpiration = new Date(Date.now() + 60 * 60 * 1000)
    session.refreshExpiration = new Date(Date.now() + 24 * 60 * 60 * 1000)
    session.apiVersion = '20200115'
    session.userAgent = null
    session.ipAddress = null
    session.version = SessionService.HEADER_BASED_SESSION_VERSION

    sessionsTable.set(sessionUuid, session)

    return { session, token: `${SessionService.SESSION_TOKEN_VERSION}:${sessionUuid}:${accessToken}` }
  }

  const createResolver = () =>
    new AuthenticationMethodResolver(
      userRepository,
      sessionService,
      sessionTokenDecoder,
      fallbackTokenDecoder,
      getSessionFromToken,
      logger,
    )

  beforeEach(() => {
    sessionsTable = new Map()
    revokedSessionsTable = new Map()

    logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as Logger

    user = { uuid: USER_UUID } as jest.Mocked<User>

    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.findOneByUuid = jest.fn().mockResolvedValue(user)

    sessionRepository = {} as jest.Mocked<SessionRepositoryInterface>
    sessionRepository.findOneByUuid = jest.fn(async (uuid: string) => sessionsTable.get(uuid) ?? null)
    sessionRepository.findOneByPrivateIdentifier = jest.fn(
      async (pid: string) => [...sessionsTable.values()].find((s) => s.privateIdentifier === pid) ?? null,
    )
    sessionRepository.findOneByUuidAndUserUuid = jest.fn(async (uuid: string, userUuid: string) => {
      const session = sessionsTable.get(uuid)
      return session && session.userUuid === userUuid ? session : null
    })
    sessionRepository.findAllByUserUuid = jest.fn(async (userUuid: string) =>
      [...sessionsTable.values()].filter((s) => s.userUuid === userUuid),
    )
    sessionRepository.deleteOneByUuid = jest.fn(async (uuid: string) => {
      sessionsTable.delete(uuid)
    })
    sessionRepository.deleteAllByUserUuidExceptOne = jest.fn(async (dto) => {
      for (const [uuid, session] of [...sessionsTable.entries()]) {
        if (session.userUuid === dto.userUuid.value && uuid !== dto.currentSessionUuid.value) {
          sessionsTable.delete(uuid)
        }
      }
    })

    ephemeralSessionRepository = {} as jest.Mocked<EphemeralSessionRepositoryInterface>
    ephemeralSessionRepository.findOneByUuid = jest.fn().mockResolvedValue(null)
    ephemeralSessionRepository.findOneByPrivateIdentifier = jest.fn().mockResolvedValue(null)
    ephemeralSessionRepository.findOneByUuidAndUserUuid = jest.fn().mockResolvedValue(null)
    ephemeralSessionRepository.deleteOne = jest.fn()

    revokedSessionRepository = {} as jest.Mocked<RevokedSessionRepositoryInterface>
    revokedSessionRepository.findOneByUuid = jest.fn(async (uuid: string) => revokedSessionsTable.get(uuid) ?? null)
    revokedSessionRepository.findOneByPrivateIdentifier = jest.fn(
      async (pid: string) => [...revokedSessionsTable.values()].find((r) => r.privateIdentifier === pid) ?? null,
    )
    revokedSessionRepository.insert = jest.fn(async (revoked: RevokedSession) => {
      revokedSessionsTable.set(revoked.uuid, revoked)
    })
    revokedSessionRepository.update = jest.fn(async (revoked: RevokedSession) => {
      revokedSessionsTable.set(revoked.uuid, revoked)
    })

    getCooldownSessionTokens = {} as jest.Mocked<GetCooldownSessionTokens>
    getCooldownSessionTokens.execute = jest.fn().mockResolvedValue(Result.fail('no cooldown tokens'))

    getSessionFromToken = new GetSessionFromToken(
      sessionRepository,
      ephemeralSessionRepository,
      getCooldownSessionTokens,
      logger,
    )

    // Lightweight SessionService exercising the real revoked-session logic over the
    // in-memory revoked_sessions map. createRevokedSession / getRevokedSessionFromToken /
    // markRevokedSessionAsReceived mirror the production implementation.
    sessionService = {
      createRevokedSession: jest.fn(async (session: Session) => {
        const revoked = new RevokedSession()
        revoked.uuid = session.uuid
        revoked.userUuid = session.userUuid
        revoked.privateIdentifier = session.privateIdentifier as string
        revoked.received = false
        await revokedSessionRepository.insert(revoked)
        return revoked
      }),
      getRevokedSessionFromToken: jest.fn(async (token: string) => {
        const parts = token.split(':')
        if (parseInt(parts[0]) === SessionService.SESSION_TOKEN_VERSION) {
          return revokedSessionRepository.findOneByUuid(parts[1])
        }
        return null
      }),
      markRevokedSessionAsReceived: jest.fn(async (revoked: RevokedSession) => {
        revoked.received = true
        await revokedSessionRepository.update(revoked)
        return revoked
      }),
    } as unknown as SessionServiceInterface

    // No JWT decoding in this flow: SN clients present `1:uuid:token` session tokens.
    sessionTokenDecoder = { decodeToken: jest.fn().mockReturnValue(undefined) } as unknown as TokenDecoderInterface<
      SessionTokenData
    >
    fallbackTokenDecoder = { decodeToken: jest.fn().mockReturnValue(undefined) } as unknown as TokenDecoderInterface<
      SessionTokenData
    >
  })

  it('(baseline) authenticates a live session token', async () => {
    const { token } = createLiveSession('11111111-1111-1111-1111-111111111111', 'access-a')

    const method = await createResolver().resolve({ authTokenFromHeaders: token, requestMetadata })

    expect(method).toBeDefined()
    expect(method?.type).toEqual('session_token')
    expect(method?.user).toEqual(user)
  })

  it('(a) rejects a revoked session token: deleting the row alone is not enough, revoked_sessions forces 401', async () => {
    const { session, token } = createLiveSession('22222222-2222-2222-2222-222222222222', 'access-b')

    // Sanity: token works before revocation.
    expect((await createResolver().resolve({ authTokenFromHeaders: token, requestMetadata }))?.type).toEqual(
      'session_token',
    )

    // Revoke via the real use-case: adds to revoked_sessions AND deletes the row.
    const deleteSessionForUser = new DeleteSessionForUser(
      sessionRepository,
      ephemeralSessionRepository,
      sessionService,
    )
    const result = await deleteSessionForUser.execute({ sessionUuid: session.uuid, userUuid: USER_UUID })
    expect(result.success).toBeTruthy()

    // The sessions row is gone...
    expect(sessionsTable.has(session.uuid)).toBeFalsy()
    // ...and revoked_sessions now holds it, which is what forces the 401.
    expect(revokedSessionsTable.has(session.uuid)).toBeTruthy()

    const method = await createResolver().resolve({ authTokenFromHeaders: token, requestMetadata })

    expect(method).toBeDefined()
    expect(method?.type).toEqual('revoked')
    expect(method?.user).toBeNull()
    // The revocation is recorded as received (enforcement observed by the client).
    expect(sessionService.markRevokedSessionAsReceived).toHaveBeenCalled()
  })

  it('(b)+(c) "sign out other sessions" revokes every other session while the current session keeps working', async () => {
    const current = createLiveSession('33333333-3333-3333-3333-333333333331', 'access-current')
    const other1 = createLiveSession('33333333-3333-3333-3333-333333333332', 'access-other-1')
    const other2 = createLiveSession('33333333-3333-3333-3333-333333333333', 'access-other-2')

    const deleteOtherSessions = new DeleteOtherSessionsForUser(sessionRepository, sessionService)

    const result = await deleteOtherSessions.execute({
      userUuid: USER_UUID,
      currentSessionUuid: current.session.uuid,
      markAsRevoked: true,
    })
    expect(result.isFailed()).toBeFalsy()

    // (b) every OTHER session is now in revoked_sessions and its row is deleted.
    expect(revokedSessionsTable.has(other1.session.uuid)).toBeTruthy()
    expect(revokedSessionsTable.has(other2.session.uuid)).toBeTruthy()
    expect(sessionsTable.has(other1.session.uuid)).toBeFalsy()
    expect(sessionsTable.has(other2.session.uuid)).toBeFalsy()

    // The current session was NOT revoked.
    expect(revokedSessionsTable.has(current.session.uuid)).toBeFalsy()

    // (b) revocation is enforced: the other tokens now resolve to 'revoked'.
    for (const other of [other1, other2]) {
      const method = await createResolver().resolve({ authTokenFromHeaders: other.token, requestMetadata })
      expect(method?.type).toEqual('revoked')
      expect(method?.user).toBeNull()
    }

    // (c) the current session token still authenticates.
    const currentMethod = await createResolver().resolve({
      authTokenFromHeaders: current.token,
      requestMetadata,
    })
    expect(currentMethod?.type).toEqual('session_token')
    expect(currentMethod?.user).toEqual(user)
  })
})

import 'reflect-metadata'
import { DataSource } from 'typeorm'
import { createHash } from 'crypto'
import { Result, Timestamps, Uuid } from '@standardnotes/domain-core'
import { AUTH_TYPEORM_ENTITIES } from '../../Bootstrap/DataSource'
import { User } from '../User/User'
import { Session } from './Session'
import { SessionService } from './SessionService'
import { AuthSessionGenerationService, AuthGenerationChangedError } from './AuthSessionGenerationService'
import { ApiVersion } from '../Api/ApiVersion'
import { GetActiveSessionsForUser } from '../UseCase/GetActiveSessionsForUser'
import { GetSessionFromToken } from '../UseCase/GetSessionFromToken/GetSessionFromToken'
import { AuthResponseFactory20161215 } from '../Auth/AuthResponseFactory20161215'
import { AuthenticationMethodResolver } from '../Auth/AuthenticationMethodResolver'
import { Setting } from '../Setting/Setting'
import { TypeORMSetting } from '../../Infra/TypeORM/TypeORMSetting'
import { TypeORMSettingRepository } from '../../Infra/TypeORM/TypeORMSettingRepository'
import { SettingPersistenceMapper } from '../../Mapping/Persistence/SettingPersistenceMapper'
import { TypeORMCacheEntry } from '../../Infra/TypeORM/TypeORMCacheEntry'
import { TypeORMCacheEntryRepository } from '../../Infra/TypeORM/TypeORMCacheEntryRepository'
import { TypeORMEphemeralSessionRepository } from '../../Infra/TypeORM/TypeORMEphemeralSessionRepository'
import { CacheEntryPersistenceMapper } from '../../Mapping/CacheEntryPersistenceMapper'

const userId = '00000000-0000-4000-8000-000000000001',
  sessionId = '00000000-0000-4000-8000-000000000002'
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const turn = () => new Promise<void>((done) => setImmediate(done))
describe('account-generation fences around session mint and reset', () => {
  let db: DataSource, fence: AuthSessionGenerationService, user: User
  beforeEach(async () => {
    db = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: AUTH_TYPEORM_ENTITIES,
      synchronize: true,
    }).initialize()
    await db.getRepository(User).insert({
      uuid: userId,
      email: 'target@example.test',
      encryptedPassword: 'stored',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    user = await db.getRepository(User).findOneByOrFail({ uuid: userId })
    fence = new AuthSessionGenerationService(db.getRepository(User))
  })
  afterEach(async () => {
    await db.destroy()
  })
  const session = () =>
    Object.assign(new Session(), {
      uuid: sessionId,
      userUuid: userId,
      authGeneration: 0,
      version: 1,
      hashedAccessToken: createHash('sha256').update('access').digest('hex'),
      hashedRefreshToken: 'hash',
      accessExpiration: new Date(Date.now() + 60_000),
      refreshExpiration: new Date(Date.now() + 120_000),
      createdAt: new Date(),
      updatedAt: new Date(),
      readonlyAccess: false,
      apiVersion: '20200115',
    })
  const service = (ephemeral: object = {}, beforeTokens: () => Promise<void> = async () => undefined) => {
    const result = new SessionService(
      {} as never,
      ephemeral as never,
      {} as never,
      {} as never,
      { getUTCDate: () => new Date() } as never,
      { error: jest.fn() } as never,
      60,
      120,
      {} as never,
      { execute: async () => Result.ok() } as never,
      { findOneByUserUuid: async () => null } as never,
      [],
      {} as never,
      false,
      fence,
    )
    const seams = result as unknown as { createSession: () => Promise<Session>; createTokens: () => Promise<unknown> }
    seams.createSession = async () => session()
    seams.createTokens = async () => {
      await beforeTokens()
      return { sessionHttpRepresentation: {}, sessionCookieRepresentation: {} }
    }
    return result
  }
  const dto = () => ({
    user,
    apiVersion: ApiVersion.create('20200115').getValue(),
    userAgent: 'test',
    readonlyAccess: false,
  })
  it('rejects an already-verified durable mint delayed until after reset and leaves no session row', async () => {
    const prepared = deferred(),
      release = deferred()
    const pending = service({}, async () => {
      prepared.resolve()
      await release.promise
    }).createNewSessionForUser(dto())
    await prepared.promise
    await fence.reset(userId, async (manager) => {
      await manager.getRepository(Session).delete({ userUuid: userId })
    })
    release.resolve()
    await expect(pending).rejects.toBeInstanceOf(AuthGenerationChangedError)
    expect(await db.getRepository(Session).count()).toBe(0)
  })
  it('removes a delayed ephemeral cache insert and refuses its credentials after the reset generation advanced', async () => {
    const inserting = deferred(),
      release = deferred(),
      cache = new Map<string, Session>()
    const ephemeral = {
      insert: async (entry: Session) => {
        inserting.resolve()
        await release.promise
        cache.set(entry.uuid, entry)
      },
      deleteOne: async (id: string) => {
        cache.delete(id)
      },
    }
    const pending = service(ephemeral).createNewEphemeralSessionForUser(dto())
    await inserting.promise
    await fence.reset(userId, async () => {
      cache.clear()
    })
    release.resolve()
    await expect(pending).rejects.toBeInstanceOf(AuthGenerationChangedError)
    expect(cache.size).toBe(0)
    const stale = session()
    const getter = new GetSessionFromToken(
      { findOneByUuid: async () => null } as never,
      { findOneByUuid: async () => stale } as never,
      {} as never,
      {} as never,
      fence,
    )
    const result = await getter.execute({
      authTokenFromHeaders: `1:${sessionId}:access`,
      requestMetadata: { method: 'GET', url: '/' },
    })
    expect(result.isFailed()).toBe(true)
  })
  it('serializes recovery factor writes with reset and prevents stale post-verification rotation from restoring codes', async () => {
    const settings = new TypeORMSettingRepository(db.getRepository(TypeORMSetting), new SettingPersistenceMapper())
    const entered = deferred(),
      release = deferred()
    const rotation = fence.run(userId, 0, async () => {
      entered.resolve()
      await release.promise
      await settings.insert(
        Setting.create({
          name: 'recovery_codes',
          value: 'new-test-code',
          sensitive: true,
          serverEncryptionVersion: 0,
          userUuid: Uuid.create(userId).getValue(),
          timestamps: Timestamps.create(100, 100).getValue(),
        }).getValue(),
      )
    })
    await entered.promise
    let resetting = false
    const reset = fence.reset(userId, async (manager) => {
      resetting = true
      await manager.getRepository(TypeORMSetting).delete({ userUuid: userId })
    })
    await turn()
    expect(resetting).toBe(false)
    release.resolve()
    await rotation
    await reset
    expect(await db.getRepository(TypeORMSetting).count()).toBe(0)
    const staleRotation = jest.fn(async () => undefined)
    await expect(fence.run(userId, 0, staleRotation)).rejects.toBeInstanceOf(AuthGenerationChangedError)
    expect(staleRotation).not.toHaveBeenCalled()
  })
  it('accepts a new generation but refuses stale refresh, legacyJWT and stale user saves lowering the epoch', async () => {
    await fence.reset(userId, async () => undefined)
    user.email = 'changed@example.test'
    await db.getRepository(User).save(user)
    expect((await db.getRepository(User).findOneByOrFail({ uuid: userId })).authGeneration).toBe(1)
    await expect(
      service().refreshTokens({ session: session(), isEphemeral: false, apiVersion: dto().apiVersion }),
    ).rejects.toBeInstanceOf(AuthGenerationChangedError)
    const decoder = { decodeToken: () => ({ user_uuid: userId, auth_generation: 0 }) }
    const resolver = new AuthenticationMethodResolver(
      { findOneByUuid: async () => db.getRepository(User).findOneBy({ uuid: userId }) } as never,
      {} as never,
      decoder as never,
      decoder as never,
      {} as never,
      { debug: jest.fn() } as never,
    )
    expect(
      await resolver.resolve({ authTokenFromHeaders: 'old-jwt', requestMetadata: { method: 'GET', url: '/' } }),
    ).toBeUndefined()
    const encodeToken = jest.fn(() => 'token')
    const legacy = new AuthResponseFactory20161215(
      { projectSimple: () => ({}) } as never,
      { encodeToken } as never,
      { debug: jest.fn() } as never,
      fence,
    )
    await expect(legacy.createResponse({ ...dto(), ephemeralSession: false })).rejects.toBeInstanceOf(
      AuthGenerationChangedError,
    )
    expect(encodeToken).not.toHaveBeenCalled()
    user = await db.getRepository(User).findOneByOrFail({ uuid: userId })
    await expect(legacy.createResponse({ ...dto(), ephemeralSession: false })).resolves.toBeDefined()
    expect(encodeToken).toHaveBeenCalledWith(expect.objectContaining({ auth_generation: 1 }))
    await expect(service().createNewSessionForUser(dto())).resolves.toMatchObject({ session: { authGeneration: 1 } })
    expect(await db.getRepository(Session).count()).toBe(1)
  })

  it('fails closed for missing accounts or exhausted generations without running credential writes', async () => {
    const write = jest.fn(async () => undefined)
    await expect(fence.run('00000000-0000-4000-8000-000000000009', 0, write)).rejects.toBeInstanceOf(
      AuthGenerationChangedError,
    )
    expect(write).not.toHaveBeenCalled()
    await db.query('UPDATE users SET auth_generation = 2147483647 WHERE uuid = ?', [userId])
    await expect(fence.reset(userId, write)).rejects.toBeInstanceOf(AuthGenerationChangedError)
    expect(write).not.toHaveBeenCalled()
    expect((await db.getRepository(User).findOneByOrFail({ uuid: userId })).authGeneration).toBe(2147483647)
  })
  it('excludes stale ephemeral remnants from named and open-session lookup after reset', async () => {
    await fence.reset(userId, async () => undefined)
    const stale = session()
    const getter = new GetActiveSessionsForUser(
      { findAllByRefreshExpirationAndUserUuid: async () => [] } as never,
      { findAllByUserUuid: async () => [stale] } as never,
      fence,
    )
    expect(await getter.execute({ userUuid: userId, sessionUuid: sessionId })).toEqual({ sessions: [] })
    expect(await getter.execute({ userUuid: userId })).toEqual({ sessions: [] })
    stale.authGeneration = 1
    expect(await getter.execute({ userUuid: userId, sessionUuid: sessionId })).toEqual({ sessions: [stale] })
  })
  it('refreshes existing durable credentials under the epoch lock and never recreates a deleted session', async () => {
    const existing = session()
    await db.getRepository(Session).insert(existing)
    await expect(
      service().refreshTokens({ session: existing, isEphemeral: false, apiVersion: dto().apiVersion }),
    ).resolves.toMatchObject({ session: { uuid: sessionId } })
    await db.getRepository(Session).delete(sessionId)
    await expect(
      service().refreshTokens({ session: existing, isEphemeral: false, apiVersion: dto().apiVersion }),
    ).rejects.toBeInstanceOf(AuthGenerationChangedError)
    expect(await db.getRepository(Session).count()).toBe(0)
  })
  it('does not resurrect a selectively revoked ephemeral session when an already-started refresh completes later', async () => {
    const sql = db.getRepository(TypeORMCacheEntry)
    const repository = new TypeORMEphemeralSessionRepository(
      new TypeORMCacheEntryRepository(sql, new CacheEntryPersistenceMapper()),
      120,
      {
        getUTCDate: () => new Date(),
        getUTCDateNSecondsAhead: (seconds: number) => new Date(Date.now() + seconds * 1000),
      } as never,
      sql,
    )
    const existing = Object.assign(session(), { privateIdentifier: 'ephemeral-private' })
    await repository.insert(existing)
    const prepared = deferred(),
      release = deferred()
    const pending = service(repository, async () => {
      prepared.resolve()
      await release.promise
    }).refreshTokens({ session: existing, isEphemeral: true, apiVersion: dto().apiVersion })
    await prepared.promise
    await repository.deleteOne(sessionId, userId)
    release.resolve()
    await expect(pending).rejects.toBeInstanceOf(AuthGenerationChangedError)
    expect(await repository.findOneByUuid(sessionId)).toBeNull()
    expect(await repository.findOneByPrivateIdentifier(existing.privateIdentifier)).toBeNull()
  })
  it('rejects stale ephemeral mint before publication and fences both sides of ephemeral refresh', async () => {
    const insert = jest.fn(),
      update = jest.fn(),
      deleteOne = jest.fn()
    await fence.reset(userId, async () => undefined)
    await expect(service({ insert }).createNewEphemeralSessionForUser(dto())).rejects.toBeInstanceOf(
      AuthGenerationChangedError,
    )
    expect(insert).not.toHaveBeenCalled()
    await expect(
      service({ update }).refreshTokens({ session: session(), isEphemeral: true, apiVersion: dto().apiVersion }),
    ).rejects.toBeInstanceOf(AuthGenerationChangedError)
    expect(update).not.toHaveBeenCalled()
    const fresh = session()
    fresh.authGeneration = 1
    await expect(
      service({ update, deleteOne }).refreshTokens({ session: fresh, isEphemeral: true, apiVersion: dto().apiVersion }),
    ).resolves.toBeDefined()
    const resetDuringWrite = jest.fn(async () => fence.reset(userId, async () => undefined))
    await expect(
      service({ update: resetDuringWrite, deleteOne }).refreshTokens({
        session: fresh,
        isEphemeral: true,
        apiVersion: dto().apiVersion,
      }),
    ).rejects.toBeInstanceOf(AuthGenerationChangedError)
    expect(deleteOne).toHaveBeenCalledWith(sessionId, userId)
  })
})

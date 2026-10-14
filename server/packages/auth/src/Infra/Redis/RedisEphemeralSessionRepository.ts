import * as IORedis from 'ioredis'

import { inject, injectable } from 'inversify'
import TYPES from '../../Bootstrap/Types'
import { EphemeralSession } from '../../Domain/Session/EphemeralSession'
import { EphemeralSessionRepositoryInterface } from '../../Domain/Session/EphemeralSessionRepositoryInterface'
import { AuthGenerationChangedError } from '../../Domain/Session/AuthSessionGenerationService'

@injectable()
export class RedisEphemeralSessionRepository implements EphemeralSessionRepositoryInterface {
  private readonly PREFIX = 'session'
  private readonly PREFIX_PRIVATE_ID = 'session-private-id'
  private readonly USER_SESSIONS_PREFIX = 'user-sessions'

  constructor(
    @inject(TYPES.Auth_Redis) private redisClient: IORedis.Redis,
    @inject(TYPES.Auth_EPHEMERAL_SESSION_AGE) private ephemeralSessionAge: number,
  ) {}

  async findOneByPrivateIdentifier(privateIdentifier: string): Promise<EphemeralSession | null> {
    const stringifiedSession = await this.redisClient.get(`${this.PREFIX_PRIVATE_ID}:${privateIdentifier}`)
    if (!stringifiedSession) {
      return null
    }

    return JSON.parse(stringifiedSession)
  }

  async deleteOne(uuid: string, userUuid: string): Promise<void> {
    await this.redisClient.eval(
      `
      local stored = redis.call('GET', KEYS[1])
      if stored then
        local session = cjson.decode(stored)
        if session.userUuid ~= ARGV[1] then return 0 end
        redis.call('DEL', ARGV[3] .. session.privateIdentifier)
      end
      redis.call('DEL', KEYS[1], KEYS[2])
      redis.call('SREM', KEYS[3], ARGV[2])
      return 1
    `,
      3,
      `${this.PREFIX}:${uuid}`,
      `${this.PREFIX}:${uuid}:${userUuid}`,
      `${this.USER_SESSIONS_PREFIX}:${userUuid}`,
      userUuid,
      uuid,
      `${this.PREFIX_PRIVATE_ID}:`,
    )
  }

  async updateTokensAndExpirationDates(
    uuid: string,
    hashedAccessToken: string,
    hashedRefreshToken: string,
    accessExpiration: Date,
    refreshExpiration: Date,
  ): Promise<void> {
    const session = await this.findOneByUuid(uuid)
    if (!session) {
      return
    }

    session.hashedAccessToken = hashedAccessToken
    session.hashedRefreshToken = hashedRefreshToken
    session.accessExpiration = accessExpiration
    session.refreshExpiration = refreshExpiration

    await this.update(session)
  }

  async findAllByUserUuid(userUuid: string): Promise<Array<EphemeralSession>> {
    const ephemeralSessionUuids = await this.redisClient.smembers(`${this.USER_SESSIONS_PREFIX}:${userUuid}`)

    const sessions = []
    for (const ephemeralSessionUuid of ephemeralSessionUuids) {
      const stringifiedSession = await this.redisClient.get(`${this.PREFIX}:${ephemeralSessionUuid}`)
      if (stringifiedSession !== null) {
        sessions.push(JSON.parse(stringifiedSession))
      }
    }

    return sessions
  }

  async findOneByUuid(uuid: string): Promise<EphemeralSession | null> {
    const stringifiedSession = await this.redisClient.get(`${this.PREFIX}:${uuid}`)
    if (!stringifiedSession) {
      return null
    }

    return JSON.parse(stringifiedSession)
  }

  async findOneByUuidAndUserUuid(uuid: string, userUuid: string): Promise<EphemeralSession | null> {
    const stringifiedSession = await this.redisClient.get(`${this.PREFIX}:${uuid}:${userUuid}`)
    if (!stringifiedSession) {
      return null
    }

    return JSON.parse(stringifiedSession)
  }

  async insert(ephemeralSession: EphemeralSession): Promise<void> {
    const ttl = this.ephemeralSessionAge

    const stringifiedSession = JSON.stringify(ephemeralSession)

    const pipeline = this.redisClient.pipeline()

    pipeline.setex(`${this.PREFIX}:${ephemeralSession.uuid}:${ephemeralSession.userUuid}`, ttl, stringifiedSession)
    pipeline.setex(`${this.PREFIX}:${ephemeralSession.uuid}`, ttl, stringifiedSession)
    pipeline.setex(`${this.PREFIX_PRIVATE_ID}:${ephemeralSession.privateIdentifier}`, ttl, stringifiedSession)

    pipeline.sadd(`${this.USER_SESSIONS_PREFIX}:${ephemeralSession.userUuid}`, ephemeralSession.uuid)
    pipeline.expire(`${this.USER_SESSIONS_PREFIX}:${ephemeralSession.userUuid}`, ttl)

    await pipeline.exec()
  }

  async update(ephemeralSession: EphemeralSession): Promise<void> {
    const updated = await this.redisClient.eval(
      `
      if redis.call('EXISTS', KEYS[1]) == 0 or redis.call('EXISTS', KEYS[2]) == 0 then return 0 end
      local session = cjson.decode(redis.call('GET', KEYS[1]))
      if session.userUuid ~= ARGV[3] then return 0 end
      for index = 1, 3 do redis.call('SETEX', KEYS[index], ARGV[1], ARGV[2]) end
      redis.call('EXPIRE', KEYS[4], ARGV[1])
      return 1
    `,
      4,
      `${this.PREFIX}:${ephemeralSession.uuid}`,
      `${this.PREFIX}:${ephemeralSession.uuid}:${ephemeralSession.userUuid}`,
      `${this.PREFIX_PRIVATE_ID}:${ephemeralSession.privateIdentifier}`,
      `${this.USER_SESSIONS_PREFIX}:${ephemeralSession.userUuid}`,
      this.ephemeralSessionAge,
      JSON.stringify(ephemeralSession),
      ephemeralSession.userUuid,
    )
    if (updated !== 1) {
      throw new AuthGenerationChangedError()
    }
  }
}

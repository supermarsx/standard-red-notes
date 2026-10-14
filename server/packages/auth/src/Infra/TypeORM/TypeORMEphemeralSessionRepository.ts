import { CacheEntryRepositoryInterface, CacheEntry } from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'

import { EphemeralSession, parseEphemeralCleanupSession } from '../../Domain/Session/EphemeralSession'
import { EphemeralSessionRepositoryInterface } from '../../Domain/Session/EphemeralSessionRepositoryInterface'
import { Repository } from 'typeorm'
import { TypeORMCacheEntry } from './TypeORMCacheEntry'
import { runAuthTypeORMTransaction } from './AuthTypeORMTransactionCoordinator'
import { AuthGenerationChangedError } from '../../Domain/Session/AuthSessionGenerationService'

export class TypeORMEphemeralSessionRepository implements EphemeralSessionRepositoryInterface {
  private readonly PREFIX = 'session'
  private readonly PREFIX_PRIVATE_ID = 'session-private-id'
  private readonly USER_SESSIONS_PREFIX = 'user-sessions'
  private cleanupCursor?: string

  constructor(
    private cacheEntryRepository: CacheEntryRepositoryInterface,
    private ephemeralSessionAge: number,
    private timer: TimerInterface,
    private ormRepository: Repository<TypeORMCacheEntry>,
  ) {}

  async findOneByPrivateIdentifier(privateIdentifier: string): Promise<EphemeralSession | null> {
    const stringifiedSession = await this.cacheEntryRepository.findUnexpiredOneByKey(
      `${this.PREFIX_PRIVATE_ID}:${privateIdentifier}`,
    )
    if (!stringifiedSession) {
      return null
    }

    return JSON.parse(stringifiedSession.props.value)
  }

  async deleteOne(uuid: string, userUuid: string): Promise<void> {
    await runAuthTypeORMTransaction(this.ormRepository.manager.connection, async (manager) => {
      const repository = manager.getRepository(TypeORMCacheEntry)
      const query = repository.createQueryBuilder('cache').where('cache.key = :key', { key: `${this.PREFIX}:${uuid}` })
      if (['mysql', 'mariadb'].includes(this.ormRepository.manager.connection.options.type)) {
        query.setLock('pessimistic_write')
      }
      const existing = await query.getOne()
      const session = existing ? (JSON.parse(existing.value) as EphemeralSession) : undefined
      if (session && session.userUuid !== userUuid) {
        return
      }
      const keys = [`${this.PREFIX}:${uuid}`, `${this.PREFIX}:${uuid}:${userUuid}`]
      if (session) {
        keys.push(`${this.PREFIX_PRIVATE_ID}:${session.privateIdentifier}`)
      }
      await repository.createQueryBuilder().delete().where('key IN (:...keys)', { keys }).execute()
    })

    const userSessionsJSON = await this.cacheEntryRepository.findUnexpiredOneByKey(
      `${this.USER_SESSIONS_PREFIX}:${userUuid}`,
    )
    if (userSessionsJSON) {
      const userSessions = JSON.parse(userSessionsJSON.props.value)
      const updatedUserSessions = userSessions.filter((sessionUuid: string) => sessionUuid !== uuid)
      userSessionsJSON.props.value = JSON.stringify(updatedUserSessions)
      await this.cacheEntryRepository.save(userSessionsJSON)
    }
  }

  async findAllByUserUuid(userUuid: string): Promise<Array<EphemeralSession>> {
    const ephemeralSessionUuidsJSON = await this.cacheEntryRepository.findUnexpiredOneByKey(
      `${this.USER_SESSIONS_PREFIX}:${userUuid}`,
    )
    if (!ephemeralSessionUuidsJSON) {
      return []
    }
    const ephemeralSessionUuids = JSON.parse(ephemeralSessionUuidsJSON.props.value)

    const sessions = []
    for (const ephemeralSessionUuid of ephemeralSessionUuids) {
      const stringifiedSession = await this.cacheEntryRepository.findUnexpiredOneByKey(
        `${this.PREFIX}:${ephemeralSessionUuid}`,
      )
      if (stringifiedSession !== null) {
        sessions.push(JSON.parse(stringifiedSession.props.value))
      }
    }

    return sessions
  }

  async findOneByUuid(uuid: string): Promise<EphemeralSession | null> {
    const stringifiedSession = await this.cacheEntryRepository.findUnexpiredOneByKey(`${this.PREFIX}:${uuid}`)
    if (!stringifiedSession) {
      return null
    }

    return JSON.parse(stringifiedSession.props.value)
  }

  async findOneByUuidAndUserUuid(uuid: string, userUuid: string): Promise<EphemeralSession | null> {
    const stringifiedSession = await this.cacheEntryRepository.findUnexpiredOneByKey(
      `${this.PREFIX}:${uuid}:${userUuid}`,
    )
    if (!stringifiedSession) {
      return null
    }

    return JSON.parse(stringifiedSession.props.value)
  }

  async update(ephemeralSession: EphemeralSession): Promise<void> {
    await runAuthTypeORMTransaction(this.ormRepository.manager.connection, async (manager) => {
      const repository = manager.getRepository(TypeORMCacheEntry)
      const query = repository
        .createQueryBuilder('cache')
        .where('cache.key = :key', { key: `${this.PREFIX}:${ephemeralSession.uuid}` })
        .andWhere('cache.expires_at > :now', { now: this.timer.getUTCDate() })
      if (['mysql', 'mariadb'].includes(this.ormRepository.manager.connection.options.type)) {
        query.setLock('pessimistic_write')
      }
      const existing = await query.getOne()
      if (!existing || JSON.parse(existing.value).userUuid !== ephemeralSession.userUuid) {
        throw new AuthGenerationChangedError()
      }
      ephemeralSession.updatedAt = this.timer.getUTCDate()
      const keys = [
        `${this.PREFIX}:${ephemeralSession.uuid}`,
        `${this.PREFIX}:${ephemeralSession.uuid}:${ephemeralSession.userUuid}`,
        `${this.PREFIX_PRIVATE_ID}:${ephemeralSession.privateIdentifier}`,
        `${this.USER_SESSIONS_PREFIX}:${ephemeralSession.userUuid}`,
      ]
      await repository
        .createQueryBuilder()
        .update()
        .set({
          value: JSON.stringify(ephemeralSession),
          expiresAt: this.timer.getUTCDateNSecondsAhead(this.ephemeralSessionAge),
        })
        .where('key IN (:...keys)', { keys: keys.slice(0, 3) })
        .execute()
      await repository
        .createQueryBuilder()
        .update()
        .set({ expiresAt: this.timer.getUTCDateNSecondsAhead(this.ephemeralSessionAge) })
        .where('key = :key', { key: keys[3] })
        .execute()
    })
  }

  async insert(ephemeralSession: EphemeralSession): Promise<void> {
    const ttl = this.ephemeralSessionAge

    ephemeralSession.updatedAt = this.timer.getUTCDate()

    const stringifiedSession = JSON.stringify(ephemeralSession)

    await this.cacheEntryRepository.save(
      CacheEntry.create({
        key: `${this.PREFIX}:${ephemeralSession.uuid}:${ephemeralSession.userUuid}`,
        value: stringifiedSession,
        expiresAt: this.timer.getUTCDateNSecondsAhead(ttl),
      }).getValue(),
    )

    await this.cacheEntryRepository.save(
      CacheEntry.create({
        key: `${this.PREFIX}:${ephemeralSession.uuid}`,
        value: stringifiedSession,
        expiresAt: this.timer.getUTCDateNSecondsAhead(ttl),
      }).getValue(),
    )

    await this.cacheEntryRepository.save(
      CacheEntry.create({
        key: `${this.PREFIX_PRIVATE_ID}:${ephemeralSession.privateIdentifier}`,
        value: stringifiedSession,
        expiresAt: this.timer.getUTCDateNSecondsAhead(ttl),
      }).getValue(),
    )

    const ephemeralSessionUuidsJSON = await this.cacheEntryRepository.findUnexpiredOneByKey(
      `${this.USER_SESSIONS_PREFIX}:${ephemeralSession.userUuid}`,
    )
    if (!ephemeralSessionUuidsJSON) {
      await this.cacheEntryRepository.save(
        CacheEntry.create({
          key: `${this.USER_SESSIONS_PREFIX}:${ephemeralSession.userUuid}`,
          value: JSON.stringify([ephemeralSession.uuid]),
          expiresAt: this.timer.getUTCDateNSecondsAhead(ttl),
        }).getValue(),
      )
    } else {
      const ephemeralSessionUuids = JSON.parse(ephemeralSessionUuidsJSON.props.value)
      ephemeralSessionUuids.push(ephemeralSession.uuid)
      ephemeralSessionUuidsJSON.props.value = JSON.stringify(ephemeralSessionUuids)
      ephemeralSessionUuidsJSON.props.expiresAt = this.timer.getUTCDateNSecondsAhead(ttl)
      await this.cacheEntryRepository.save(ephemeralSessionUuidsJSON)
    }
  }
  async getNextCleanupBatch(limit: number): Promise<EphemeralSession[]> {
    const query = this.ormRepository
      .createQueryBuilder('cache')
      .where('cache.key LIKE :prefix AND cache.key NOT LIKE :alias', {
        prefix: `${this.PREFIX}:%`,
        alias: `${this.PREFIX}:%:%`,
      })
      .orderBy('cache.uuid', 'ASC')
      .take(limit)
    if (this.cleanupCursor) {
      query.andWhere('cache.uuid > :cursor', { cursor: this.cleanupCursor })
    }
    const rows = await query.getMany()
    this.cleanupCursor = rows.length ? rows[rows.length - 1].uuid : undefined
    return rows
      .map((row) => parseEphemeralCleanupSession(row.value))
      .filter((session): session is EphemeralSession => session !== undefined)
  }
}

import 'reflect-metadata'
import { DataSource } from 'typeorm'
import { TypeORMCacheEntry } from './TypeORMCacheEntry'
import { TypeORMCacheEntryRepository } from './TypeORMCacheEntryRepository'
import { TypeORMEphemeralSessionRepository } from './TypeORMEphemeralSessionRepository'
import { CacheEntryPersistenceMapper } from '../../Mapping/CacheEntryPersistenceMapper'
import { EphemeralSession } from '../../Domain/Session/EphemeralSession'
import { AuthGenerationChangedError } from '../../Domain/Session/AuthSessionGenerationService'

describe('selective ephemeral revoke cannot be undone by refresh', () => {
  let db: DataSource, repository: TypeORMEphemeralSessionRepository
  const session = () =>
    Object.assign(new EphemeralSession(), {
      uuid: 'session-a',
      userUuid: 'user-a',
      privateIdentifier: 'private-a',
      hashedAccessToken: 'old',
      refreshExpiration: new Date(Date.now() + 60000),
    })
  beforeEach(async () => {
    db = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [TypeORMCacheEntry],
      synchronize: true,
    }).initialize()
    const sql = db.getRepository(TypeORMCacheEntry)
    repository = new TypeORMEphemeralSessionRepository(
      new TypeORMCacheEntryRepository(sql, new CacheEntryPersistenceMapper()),
      120,
      {
        getUTCDate: () => new Date(),
        getUTCDateNSecondsAhead: (seconds: number) => new Date(Date.now() + seconds * 1000),
      } as never,
      sql,
    )
  })
  afterEach(async () => {
    await db.destroy()
  })
  it('updates existing aliases without adding duplicate entries and rejects a stale snapshot after selective revoke', async () => {
    const item = session()
    await repository.insert(item)
    const stale = await repository.findOneByUuid(item.uuid)
    item.hashedAccessToken = 'fresh'
    await repository.update(item)
    expect((await repository.findOneByPrivateIdentifier(item.privateIdentifier))?.hashedAccessToken).toBe('fresh')
    expect(await repository.findAllByUserUuid(item.userUuid)).toHaveLength(1)
    await repository.deleteOne(item.uuid, item.userUuid)
    await expect(repository.update(stale!)).rejects.toBeInstanceOf(AuthGenerationChangedError)
    expect(await repository.findOneByUuid(item.uuid)).toBeNull()
    expect(await repository.findOneByUuidAndUserUuid(item.uuid, item.userUuid)).toBeNull()
    expect(await repository.findOneByPrivateIdentifier(item.privateIdentifier)).toBeNull()
    expect(await repository.findAllByUserUuid(item.userUuid)).toEqual([])
  })
  it('serializes an in-flight existing refresh with revoke and refuses expired refresh rows', async () => {
    const item = session()
    await repository.insert(item)
    await Promise.all([repository.update(item), repository.deleteOne(item.uuid, item.userUuid)])
    expect(await repository.findOneByUuid(item.uuid)).toBeNull()
    await repository.insert(item)
    await db
      .getRepository(TypeORMCacheEntry)
      .createQueryBuilder()
      .update()
      .set({ expiresAt: new Date(0) })
      .execute()
    await expect(repository.update(item)).rejects.toBeInstanceOf(AuthGenerationChangedError)
  })
})

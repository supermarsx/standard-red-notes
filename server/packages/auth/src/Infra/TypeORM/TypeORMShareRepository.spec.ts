import { DataSource } from 'typeorm'
import { UniqueEntityId, Uuid } from '@standardnotes/domain-core'
import { TypeORMShare } from './TypeORMShare'
import { TypeORMShareRepository } from './TypeORMShareRepository'
import { SharePersistenceMapper } from '../../Mapping/SharePersistenceMapper'
import { GetShare } from '../../Domain/UseCase/GetShare/GetShare'

describe('share expiry ciphertext cleanup against SQLite', () => {
  let database: DataSource
  let repository: TypeORMShareRepository
  const owner = '00000000-0000-0000-0000-000000000001'
  const otherOwner = '00000000-0000-0000-0000-000000000002'
  const now = new Date('2026-10-09T10:56:37Z')
  const row = (uuid: string, extra: Partial<TypeORMShare> = {}): TypeORMShare => ({
    uuid,
    userUuid: owner,
    type: 'note',
    encryptedPayload: 'opaque-ciphertext',
    nickname: 'history retained',
    createdAt: now.getTime() - 20 * 60_000,
    revoked: false,
    oneTimeView: false,
    viewExpiresMinutes: 15,
    firstOpenedAt: now.getTime() - 15 * 60_000,
    ...extra,
  })
  beforeEach(async () => {
    database = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [TypeORMShare],
      synchronize: true,
    })
    await database.initialize()
    repository = new TypeORMShareRepository(database.getRepository(TypeORMShare), new SharePersistenceMapper())
  })
  afterEach(async () => database?.destroy())

  it('erases expired payloads at the boundary, keeping unopened and unexpired links and owner metadata', async () => {
    const orm = database.getRepository(TypeORMShare)
    await orm.save([
      row('expired'),
      row('active', { firstOpenedAt: now.getTime() - 15 * 60_000 + 1 }),
      row('unopened', { firstOpenedAt: null }),
      row('ordinary', { viewExpiresMinutes: null }),
    ])
    await repository.revokeExpiredAndErasePayloads(now)
    expect(await orm.findOneByOrFail({ uuid: 'expired' })).toMatchObject({
      revoked: true,
      encryptedPayload: '',
      nickname: 'history retained',
    })
    for (const uuid of ['active', 'unopened', 'ordinary']) {
      expect(await orm.findOneByOrFail({ uuid })).toMatchObject({
        revoked: false,
        encryptedPayload: 'opaque-ciphertext',
      })
    }
    expect((await repository.findById(new UniqueEntityId('expired')))?.props.encryptedPayload).toBe('')
  })

  it('scopes both expiry and already-revoked cleanup branches to the requesting owner', async () => {
    const orm = database.getRepository(TypeORMShare)
    await orm.save([
      row('own-expired'),
      row('own-revoked', { revoked: true }),
      row('other-expired', { userUuid: otherOwner }),
      row('other-revoked', { userUuid: otherOwner, revoked: true }),
    ])
    await repository.revokeExpiredAndErasePayloads(now, Uuid.create(owner).getValue())
    expect((await orm.findOneByOrFail({ uuid: 'own-expired' })).encryptedPayload).toBe('')
    expect((await orm.findOneByOrFail({ uuid: 'own-revoked' })).encryptedPayload).toBe('')
    expect((await orm.findOneByOrFail({ uuid: 'other-expired' })).encryptedPayload).toBe('opaque-ciphertext')
    expect((await orm.findOneByOrFail({ uuid: 'other-revoked' })).encryptedPayload).toBe('opaque-ciphertext')
  })

  it('consumes a one-time read and erases its payload while allowing the winning response to return its loaded ciphertext', async () => {
    const orm = database.getRepository(TypeORMShare)
    await orm.save(row('burn', { oneTimeView: true, firstOpenedAt: null, viewExpiresMinutes: null }))
    const read = new GetShare(repository)
    const first = await read.execute({ shareId: 'burn' })
    expect(first.getValue().encryptedPayload).toBe('opaque-ciphertext')
    expect(await orm.findOneByOrFail({ uuid: 'burn' })).toMatchObject({ revoked: true, encryptedPayload: '' })
    expect((await read.execute({ shareId: 'burn' })).isFailed()).toBe(true)
  })

  it('cannot first-open a revoked link and also erases manually revoked ciphertext', async () => {
    const orm = database.getRepository(TypeORMShare)
    await orm.save(row('manual', { firstOpenedAt: null }))
    await repository.markRevoked(new UniqueEntityId('manual'))
    expect(await repository.markFirstOpenedAtomically(new UniqueEntityId('manual'), now)).toBe(false)
    expect(await orm.findOneByOrFail({ uuid: 'manual' })).toMatchObject({
      firstOpenedAt: null,
      revoked: true,
      encryptedPayload: '',
    })
  })
})

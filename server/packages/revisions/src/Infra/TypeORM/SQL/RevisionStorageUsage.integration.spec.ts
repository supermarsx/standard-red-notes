import { DataSource } from 'typeorm'
import { SQLRevision } from './SQLRevision'
import { RevisionStorageUsage } from './RevisionStorageUsage'
const user = '00000000-0000-4000-8000-000000000001',
  vault = '00000000-0000-4000-8000-000000000002'
describe('revision stored UTF8 byte measurement', () => {
  let db: DataSource
  beforeEach(async () => {
    db = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [SQLRevision],
      synchronize: true,
    }).initialize()
  })
  afterEach(async () => {
    await db.destroy()
  })
  it('counts personal plus ownedvault history once, includesUTF8 keys, excludes member-only data', async () => {
    const repo = db.getRepository(SQLRevision)
    await repo.insert([
      {
        uuid: '00000000-0000-4000-8000-000000000003',
        itemUuid: user,
        userUuid: user,
        content: 'é',
        encItemKey: 'key',
        authHash: 'h',
      },
      {
        uuid: '00000000-0000-4000-8000-000000000004',
        itemUuid: user,
        userUuid: user,
        sharedVaultUuid: vault,
        content: 'vault',
      },
      {
        uuid: '00000000-0000-4000-8000-000000000005',
        itemUuid: user,
        userUuid: user,
        sharedVaultUuid: '00000000-0000-4000-8000-000000000006',
        content: 'not-owned',
      },
    ])
    const usage = new RevisionStorageUsage(repo, 'internal-key')
    expect(await usage.measure({ userUuid: user, vaultUuids: [vault] })).toEqual({
      bytes: 11,
      count: 2,
      complete: true,
    })
    expect(await usage.measure({ userUuid: vault, vaultUuids: [] })).toEqual({ bytes: 0, count: 0, complete: true })
  })
})

import { randomUUID } from 'node:crypto'
import { DataSource, Repository } from 'typeorm'
import { RevisionPolicyResolver, RevisionPolicySettings } from '@standardnotes/domain-core'
import { SQLRevision } from './SQLRevision'
import { RevisionRetention } from './RevisionRetention'

const user = '00000000-0000-4000-8000-000000000001'
const other = '00000000-0000-4000-8000-000000000002'
const item = '00000000-0000-4000-8000-000000000003'
const DAY = 86_400_000
describe('atomic revision retention and automatic checkpoints', () => {
  let db: DataSource, repository: Repository<SQLRevision>, retention: RevisionRetention
  let settings: RevisionPolicySettings, now: number
  const row = (changes: Partial<SQLRevision> = {}): SQLRevision =>
    Object.assign(new SQLRevision(), {
      uuid: randomUUID(),
      itemUuid: item,
      userUuid: user,
      content: randomUUID(),
      contentType: 'Note',
      encItemKey: null,
      authHash: null,
      itemsKeyId: null,
      sharedVaultUuid: null,
      keySystemIdentifier: null,
      editedBy: null,
      editedByUuid: user,
      createdAt: new Date(now),
      updatedAt: new Date(now),
      creationDate: new Date(now),
      sourceUpdatedAt: now * 1000,
      coalescedChanges: 1,
      ...changes,
    })
  beforeEach(async () => {
    now = Date.parse('2026-10-15T12:00:00Z')
    settings = {}
    db = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [SQLRevision],
      synchronize: true,
    }).initialize()
    await db.query('CREATE TABLE revisions_policy_lock (id integer NOT NULL PRIMARY KEY)')
    await db.query('INSERT INTO revisions_policy_lock (id) VALUES (1)')
    repository = db.getRepository(SQLRevision)
    const policies = new RevisionPolicyResolver(undefined)
    jest.spyOn(policies, 'settings').mockImplementation(async () => settings)
    retention = new RevisionRetention(repository, policies, () => now)
  })
  afterEach(async () => db.destroy())

  it('keeps the newest 200 and removes snapshots older than 900 days', async () => {
    const rows = Array.from({ length: 205 }, (_, n) =>
      row({ createdAt: new Date(now - n * DAY), updatedAt: new Date(now - n * DAY) }),
    )
    rows.push(row({ createdAt: new Date(now - 901 * DAY), updatedAt: new Date(now - 901 * DAY) }))
    await retention.store(rows, false)
    expect(await repository.count()).toBe(200)
    expect(await repository.findOneBy({ uuid: rows[0].uuid })).not.toBeNull()
    expect(await repository.findOneBy({ uuid: rows[200].uuid })).toBeNull()
  })
  it('coalesces a typing burst but creates a new checkpoint after idle or the maximum interval', async () => {
    const first = row({ content: 'first' })
    await retention.store([first], true)
    now += 10_000
    await retention.store([row({ content: 'latest' })], true)
    expect(await repository.count()).toBe(1)
    expect(await repository.findOneBy({ uuid: first.uuid })).toMatchObject({ content: 'latest', coalescedChanges: 2 })
    now += 31_000
    await retention.store([row()], true)
    expect(await repository.count()).toBe(2)
    for (let n = 0; n < 31; n++) {
      now += 10_000
      await retention.store([row()], true)
    }
    expect(await repository.count()).toBe(3)
  })
  it('ignores redelivered and out-of-order dumps without replacing newer history', async () => {
    const first = row({ content: 'first' })
    await retention.store([first], true)
    now += 1000
    await retention.store([row({ content: 'latest' })], true)
    await retention.store([first], true)
    expect(await repository.count()).toBe(1)
    expect((await repository.find())[0].content).toBe('latest')
  })
  it('keeps author and encryption boundaries instead of merging unrelated snapshots', async () => {
    await retention.store([row()], true)
    now += 1000
    await retention.store([row({ editedByUuid: other })], true)
    now += 1000
    await retention.store([row({ editedByUuid: other, itemsKeyId: 'new-key' })], true)
    expect(await repository.count()).toBe(3)
  })
  it('enforces count caps across items and accounts, oldest first with stable ties', async () => {
    settings = { maxCountPerUser: 3, maxCountTotal: 4 }
    const rows = Array.from({ length: 6 }, (_, n) =>
      row({
        itemUuid: randomUUID(),
        userUuid: n < 4 ? user : other,
        createdAt: new Date(now + n),
        updatedAt: new Date(now + n),
      }),
    )
    await retention.store(rows, false)
    expect(await repository.count()).toBe(4)
    expect(await repository.findOneBy({ uuid: rows[0].uuid })).toBeNull()
    expect(await repository.findOneBy({ uuid: rows[1].uuid })).toBeNull()
    expect(await repository.findOneBy({ uuid: rows[5].uuid })).not.toBeNull()
  })
  it('counts UTF8 ciphertext, encrypted keys and auth bytes against both byte caps', async () => {
    settings = { maxBytesPerUser: 12, maxBytesTotal: 15 }
    await retention.store([row({ itemUuid: randomUUID(), content: 'éé', encItemKey: 'key', authHash: 'h' })], false)
    now += 1000
    const newest = row({ itemUuid: randomUUID(), content: 'newest' })
    await retention.store([newest], false)
    expect(await repository.count()).toBe(1)
    now += 1000
    await retention.store([row({ itemUuid: randomUUID(), userUuid: other, content: '0123456789' })], false)
    expect(await repository.count()).toBe(1)
    expect(await repository.findOneBy({ uuid: newest.uuid })).toBeNull()
  })
  it('applies tighter user overrides and skips an oversized snapshot while preserving useful history', async () => {
    settings = { maxCountPerUser: 10, users: { [user]: { maxCount: 1, maxBytes: 5 } } }
    await retention.store([row({ content: 'a' }), row({ content: 'b' })], false)
    expect(await repository.count()).toBe(1)
    const kept = (await repository.find())[0].uuid
    await retention.store([row({ content: 'oversized' })], false)
    expect((await repository.find()).map((revision) => revision.uuid)).toEqual([kept])
  })
  it('serializes simultaneous admissions so an absolute cap is never exceeded at commit', async () => {
    settings = { maxCountTotal: 2, debounceSeconds: 0 }
    await Promise.all(Array.from({ length: 10 }, () => retention.store([row({ itemUuid: randomUUID() })], true)))
    expect(await repository.count()).toBe(2)
  })
  it('sweeps inactive notes and applies changed limits without a new edit', async () => {
    await repository.insert([row({ createdAt: new Date(now - 901 * DAY) }), row(), row()])
    settings = { maxCountPerItem: 1 }
    await retention.sweep()
    expect(await repository.count()).toBe(1)
  })
  it('enforces the receiving owner cap during reassignment', async () => {
    settings = { maxCountPerUser: 1 }
    await retention.store([row({ userUuid: other })], false)
    now += 1000
    const existing = row({ itemUuid: randomUUID() })
    await retention.store([existing], false)
    await retention.reassign(item, user)
    expect(await repository.count()).toBe(1)
    expect(await repository.findOneBy({ uuid: existing.uuid })).not.toBeNull()
  })
  it('rolls back a failed admission and its pruning together', async () => {
    settings = { maxCountTotal: 1 }
    const first = row()
    await retention.store([first], false)
    await expect(retention.store([row(), row({ uuid: first.uuid })], false)).rejects.toThrow()
    expect((await repository.find()).map((r) => r.uuid)).toEqual([first.uuid])
  })
})

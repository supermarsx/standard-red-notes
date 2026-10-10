import { Repository, DataSource } from 'typeorm'
import { Uuid } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { SQLItemPersistenceMapper } from '../../Mapping/Persistence/SQLItemPersistenceMapper'
import { SQLItem } from './SQLItem'
import { SQLItemRepository } from './SQLItemRepository'

/**
 * Standard Red Notes: `markItemsAsDeleted` is a BULK WRITE KEYED ONLY ON UUIDS.
 *
 * It took a list of uuids and an `updated_at_timestamp` and ran
 * `UPDATE items SET deleted = 1, content = NULL, ... WHERE uuid IN (...)`, with
 * no predicate naming an owner. Any caller that assembled that list from one
 * account's input — a batch delete, a vault cleanup, a backfill — would erase
 * another account's rows the moment a single foreign uuid entered the list, and
 * the content columns are nulled in the same statement, so the rows are not just
 * flagged, they are emptied.
 *
 * The second case here is the whole point: it is written so that it PASSES over
 * the unguarded query only if that query never touches a row it was not given
 * the owner of, which it does. It fails against the unguarded version.
 *
 * This runs against a real database rather than the house Map-backed repository
 * fake, because a fake keyed by uuid cannot express the difference between "one
 * row matched" and "two rows matched" — the exact difference under test.
 */
describe('SQLItemRepository.markItemsAsDeleted', () => {
  let dataSource: DataSource
  let ormRepository: Repository<SQLItem>
  let repository: SQLItemRepository

  const owner = Uuid.create('00000000-0000-0000-0000-000000000002').getValue()
  const stranger = Uuid.create('00000000-0000-0000-0000-000000000003').getValue()

  let nextUuid = 0

  const insertRow = async (rowOwner: Uuid): Promise<string> => {
    nextUuid += 1
    const row = new SQLItem()
    row.uuid = `00000000-0000-0000-0000-${String(nextUuid).padStart(12, '0')}`
    row.duplicateOf = null
    row.itemsKeyId = 'items-key-id'
    row.content = 'ciphertext'
    row.contentType = 'Note'
    row.contentSize = 10
    row.encItemKey = 'enc-item-key'
    row.authHash = 'auth-hash'
    row.userUuid = rowOwner.value
    row.deleted = false
    row.createdAt = new Date(1000)
    row.updatedAt = new Date(2000)
    row.createdAtTimestamp = 100
    row.updatedAtTimestamp = 200
    row.updatedWithSession = null
    row.lastEditedBy = null
    row.sharedVaultUuid = null
    row.keySystemIdentifier = null

    await ormRepository.insert(row)

    return row.uuid
  }

  const readRow = async (uuid: string): Promise<SQLItem> => (await ormRepository.findOneByOrFail({ uuid })) as SQLItem

  beforeEach(async () => {
    nextUuid = 0
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [SQLItem],
      synchronize: true,
    })
    await dataSource.initialize()
    ormRepository = dataSource.getRepository(SQLItem)

    const logger = { error: jest.fn() } as unknown as Logger
    repository = new SQLItemRepository(ormRepository, new SQLItemPersistenceMapper(), logger)
  })

  afterEach(async () => {
    await dataSource.destroy()
  })

  it("empties and flags the owner's own rows", async () => {
    const first = await insertRow(owner)
    const second = await insertRow(owner)

    await repository.markItemsAsDeleted([first, second], 999, owner)

    for (const uuid of [first, second]) {
      const row = await readRow(uuid)
      expect(!!row.deleted).toBe(true)
      expect(row.content).toBeNull()
      expect(row.encItemKey).toBeNull()
      expect(row.authHash).toBeNull()
      expect(Number(row.updatedAtTimestamp)).toBe(999)
    }
  })

  it("refuses to touch a stranger's row named in the same uuid list", async () => {
    const mine = await insertRow(owner)
    const theirs = await insertRow(stranger)

    await repository.markItemsAsDeleted([mine, theirs], 999, owner)

    const strangersRow = await readRow(theirs)
    expect(!!strangersRow.deleted).toBe(false)
    expect(strangersRow.content).toBe('ciphertext')
    expect(strangersRow.encItemKey).toBe('enc-item-key')
    expect(strangersRow.authHash).toBe('auth-hash')
    expect(Number(strangersRow.updatedAtTimestamp)).toBe(200)

    const myRow = await readRow(mine)
    expect(!!myRow.deleted).toBe(true)
  })

  it('leaves every row alone when given no uuids at all', async () => {
    const mine = await insertRow(owner)

    await repository.markItemsAsDeleted([], 999, owner)

    const row = await readRow(mine)
    expect(!!row.deleted).toBe(false)
    expect(row.content).toBe('ciphertext')
  })

  /**
   * The MySQL schema this server ships with declares `items.user_uuid` NULLABLE
   * (`init_database` created it as `varchar(36) NULL`), so a row this server
   * cannot attribute to anyone is a row that really exists. The entity declares
   * the column non-null, which is why this case builds its own table instead of
   * letting `synchronize` build one: the state under test is one the entity
   * refuses to describe and the database allows anyway.
   *
   * A statement that NULLs `content` must leave such a row alone. The guard is
   * therefore written as the positive `user_uuid = :userUuid` and not widened
   * with an `IS NULL` arm to be kind to legacy rows — being kind here means
   * emptying an item whose owner is unknown.
   */
  describe('a row whose owner the database does not know', () => {
    let nullableDataSource: DataSource

    const orphanUuid = '00000000-0000-0000-0000-0000000000ff'

    beforeEach(async () => {
      nullableDataSource = new DataSource({
        type: 'better-sqlite3',
        database: ':memory:',
        entities: [SQLItem],
        synchronize: false,
      })
      await nullableDataSource.initialize()
      await nullableDataSource.query(
        'CREATE TABLE items (uuid varchar(36) NOT NULL PRIMARY KEY, duplicate_of varchar(36) NULL, ' +
          'items_key_id varchar(255) NULL, content text NULL, content_type varchar(255) NULL, ' +
          'content_size integer NULL, enc_item_key text NULL, auth_hash varchar(255) NULL, ' +
          'user_uuid varchar(36) NULL, deleted tinyint NULL DEFAULT 0, created_at datetime NOT NULL, ' +
          'updated_at datetime NOT NULL, created_at_timestamp bigint NOT NULL, ' +
          'updated_at_timestamp bigint NOT NULL, updated_with_session varchar(36) NULL, ' +
          'last_edited_by varchar(36) NULL, shared_vault_uuid varchar(36) NULL, ' +
          'key_system_identifier varchar(36) NULL)',
      )
      await nullableDataSource.query(
        'INSERT INTO items (uuid, user_uuid, content, content_type, content_size, enc_item_key, auth_hash, ' +
          'deleted, created_at, updated_at, created_at_timestamp, updated_at_timestamp) ' +
          'VALUES (?, NULL, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)',
        [
          orphanUuid,
          'ciphertext',
          'Note',
          10,
          'enc-item-key',
          'auth-hash',
          new Date(1000).toISOString(),
          new Date(2000).toISOString(),
          100,
          200,
        ],
      )

      const logger = { error: jest.fn() } as unknown as Logger
      repository = new SQLItemRepository(
        nullableDataSource.getRepository(SQLItem),
        new SQLItemPersistenceMapper(),
        logger,
      )
    })

    afterEach(async () => {
      await nullableDataSource.destroy()
    })

    it('is left untouched rather than emptied', async () => {
      await repository.markItemsAsDeleted([orphanUuid], 999, owner)

      const [row] = (await nullableDataSource.query('SELECT * FROM items WHERE uuid = ?', [orphanUuid])) as Array<{
        deleted: number
        content: string | null
        enc_item_key: string | null
        updated_at_timestamp: number
      }>
      expect(!!row.deleted).toBe(false)
      expect(row.content).toBe('ciphertext')
      expect(row.enc_item_key).toBe('enc-item-key')
      expect(Number(row.updated_at_timestamp)).toBe(200)
    })
  })
})

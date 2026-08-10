import { DataSource, QueryRunner } from 'typeorm'

import { initialBoilerplate1682587956616 } from '../../migrations/sqlite/1682587956616-initial-boilerplate'
import { AddSharedVaultsWithUsersAndInvites1689677867175 } from '../../migrations/sqlite/1689677867175-add-shared-vaults-with-users-and-invites'
import { DeletePrivileges1690901030484 } from '../../migrations/sqlite/1690901030484-delete_privileges'
import { UpdateUnknownContent1690975207883 } from '../../migrations/sqlite/1690975207883-update_unknown_content'
import { AddDesignatedSurvivor1695284249461 } from '../../migrations/sqlite/1695284249461-add-designated-survivor'

describe('SQLite migration integrity', () => {
  let dataSource: DataSource
  let queryRunner: QueryRunner

  beforeEach(async () => {
    dataSource = new DataSource({ type: 'better-sqlite3', database: ':memory:' })
    await dataSource.initialize()
    queryRunner = dataSource.createQueryRunner()
    await queryRunner.connect()
  })

  afterEach(async () => {
    await queryRunner.release()
    await dataSource.destroy()
  })

  it('applies content-value migrations without treating values as identifiers', async () => {
    await new initialBoilerplate1682587956616().up(queryRunner)
    const itemValues = {
      duplicateOf: null,
      itemsKeyId: null,
      content: 'encrypted-content',
      contentSize: 17,
      encItemKey: null,
      authHash: null,
      userUuid: 'user-1',
      deleted: 0,
      createdAt: '2026-08-10 12:00:00.000',
      updatedAt: '2026-08-10 12:00:00.000',
      createdAtTimestamp: 1,
      updatedAtTimestamp: 1,
      updatedWithSession: null,
    }
    const insertItem = async (uuid: string, contentType: string) =>
      queryRunner.query(
        'INSERT INTO "items" ("uuid", "duplicate_of", "items_key_id", "content", "content_type", "content_size", "enc_item_key", "auth_hash", "user_uuid", "deleted", "created_at", "updated_at", "created_at_timestamp", "updated_at_timestamp", "updated_with_session") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          uuid,
          itemValues.duplicateOf,
          itemValues.itemsKeyId,
          itemValues.content,
          contentType,
          itemValues.contentSize,
          itemValues.encItemKey,
          itemValues.authHash,
          itemValues.userUuid,
          itemValues.deleted,
          itemValues.createdAt,
          itemValues.updatedAt,
          itemValues.createdAtTimestamp,
          itemValues.updatedAtTimestamp,
          itemValues.updatedWithSession,
        ],
      )

    await insertItem('unknown-item', 'Unknown')
    await insertItem('privileges-item', 'SN|Privileges')
    await insertItem('untouched-item', 'Tag')

    await new UpdateUnknownContent1690975207883().up(queryRunner)
    await new DeletePrivileges1690901030484().up(queryRunner)

    expect(await queryRunner.query('SELECT "uuid", "content_type" FROM "items" ORDER BY "uuid"')).toEqual([
      { uuid: 'unknown-item', content_type: 'Note' },
      { uuid: 'untouched-item', content_type: 'Tag' },
    ])
  })

  it('preserves every seeded column through a table-rebuilding schema upgrade and rollback', async () => {
    await new AddSharedVaultsWithUsersAndInvites1689677867175().up(queryRunner)
    await queryRunner.query(
      'INSERT INTO "shared_vault_users" ("uuid", "shared_vault_uuid", "user_uuid", "permission", "created_at_timestamp", "updated_at_timestamp") VALUES (?, ?, ?, ?, ?, ?)',
      ['membership-1', 'vault-1', 'user-1', 'WRITE', 101, 202],
    )

    const migration = new AddDesignatedSurvivor1695284249461()
    await migration.up(queryRunner)

    expect(await queryRunner.query('SELECT * FROM "shared_vault_users"')).toEqual([
      {
        uuid: 'membership-1',
        shared_vault_uuid: 'vault-1',
        user_uuid: 'user-1',
        permission: 'WRITE',
        created_at_timestamp: 101,
        updated_at_timestamp: 202,
        is_designated_survivor: 0,
      },
    ])

    await migration.down(queryRunner)
    expect(await queryRunner.query('SELECT * FROM "shared_vault_users"')).toEqual([
      {
        uuid: 'membership-1',
        shared_vault_uuid: 'vault-1',
        user_uuid: 'user-1',
        permission: 'WRITE',
        created_at_timestamp: 101,
        updated_at_timestamp: 202,
      },
    ])
  })
})

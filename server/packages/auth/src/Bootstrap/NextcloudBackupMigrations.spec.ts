import { DataSource, QueryRunner } from 'typeorm'

import { NextcloudBackupUserLocks1785456000000 as MysqlMigration } from '../../migrations/mysql/1785456000000-nextcloud-backup-user-locks'
import { NextcloudBackupUserLocks1785456000000 as SqliteMigration } from '../../migrations/sqlite/1785456000000-nextcloud-backup-user-locks'

describe('Nextcloud backup user-lock migrations', () => {
  it.each([
    ['MySQL', new MysqlMigration()],
    ['SQLite', new SqliteMigration()],
  ])('creates a primary-key lock row with user deletion cascade on %s', async (_database, migration) => {
    const query = jest.fn().mockResolvedValue(undefined)

    await migration.up({ query } as unknown as QueryRunner)

    expect(query).toHaveBeenCalledTimes(1)
    const sql = query.mock.calls[0][0] as string
    expect(sql).toContain('nextcloud_backup_user_locks')
    expect(sql).toMatch(/PRIMARY KEY/i)
    expect(sql).toMatch(
      /FOREIGN KEY \([`"]user_uuid[`"]\) REFERENCES [`"]users[`"] \([`"]uuid[`"]\) ON DELETE CASCADE/i,
    )
  })

  it('applies the SQLite migration with a working primary key and deletion cascade, then rolls it back', async () => {
    const dataSource = new DataSource({ type: 'better-sqlite3', database: ':memory:' })
    await dataSource.initialize()
    const queryRunner = dataSource.createQueryRunner()
    await queryRunner.connect()

    try {
      await queryRunner.query('PRAGMA foreign_keys = ON')
      await queryRunner.query('CREATE TABLE "users" ("uuid" varchar(36) PRIMARY KEY NOT NULL)')
      const migration = new SqliteMigration()
      await migration.up(queryRunner)

      const columns = (await queryRunner.query('PRAGMA table_info("nextcloud_backup_user_locks")')) as Array<{
        name: string
        pk: number
      }>
      const foreignKeys = (await queryRunner.query('PRAGMA foreign_key_list("nextcloud_backup_user_locks")')) as Array<{
        table: string
        from: string
        to: string
        on_delete: string
      }>
      expect(columns.find((column) => column.name === 'user_uuid')?.pk).toBe(1)
      expect(foreignKeys).toContainEqual(
        expect.objectContaining({
          table: 'users',
          from: 'user_uuid',
          to: 'uuid',
          on_delete: 'CASCADE',
        }),
      )

      await queryRunner.query('INSERT INTO "users" ("uuid") VALUES (?)', ['user-1'])
      await queryRunner.query('INSERT INTO "nextcloud_backup_user_locks" ("user_uuid", "updated_at") VALUES (?, ?)', [
        'user-1',
        1,
      ])
      await queryRunner.query('DELETE FROM "users" WHERE "uuid" = ?', ['user-1'])
      expect(await queryRunner.query('SELECT * FROM "nextcloud_backup_user_locks"')).toEqual([])

      await migration.down(queryRunner)
      expect(
        await queryRunner.query('SELECT name FROM sqlite_master WHERE type = ? AND name = ?', [
          'table',
          'nextcloud_backup_user_locks',
        ]),
      ).toEqual([])
    } finally {
      await queryRunner.release()
      await dataSource.destroy()
    }
  })
})

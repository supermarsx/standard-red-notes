import { DataSource } from 'typeorm'

import { AddSyncCommandJournal1787000000000 } from '../../migrations/sqlite/1787000000000-add-sync-command-journal'

describe('sync command migration', () => {
  it('applies and rolls back the SQLite journal without leaving tables behind', async () => {
    const dataSource = new DataSource({ type: 'better-sqlite3', database: ':memory:' })
    await dataSource.initialize()
    const queryRunner = dataSource.createQueryRunner()
    await queryRunner.connect()
    const migration = new AddSyncCommandJournal1787000000000()

    try {
      await migration.up(queryRunner)
      await queryRunner.query(
        'INSERT INTO "sync_commands" ("uuid", "user_uuid", "session_uuid", "command_id", "request_digest", "status", "created_at_timestamp", "updated_at_timestamp", "expires_at_timestamp") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['uuid-1', 'user-1', 'session-1', 'command-1', 'a'.repeat(64), 'accepted', 1, 1, 2],
      )
      expect(await queryRunner.query('SELECT "command_id", "status" FROM "sync_commands"')).toEqual([
        { command_id: 'command-1', status: 'accepted' },
      ])

      await migration.down(queryRunner)
      const tables = await queryRunner.query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sync_commands', 'sync_command_outbox')",
      )
      expect(tables).toEqual([])
    } finally {
      await queryRunner.release()
      await dataSource.destroy()
    }
  })
})

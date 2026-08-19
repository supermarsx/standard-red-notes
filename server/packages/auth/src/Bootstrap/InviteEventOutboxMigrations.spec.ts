import { QueryRunner } from 'typeorm'

import { inviteEventOutbox1787097600000 as MySqlMigration } from '../../migrations/mysql/1787097600000-invite-event-outbox'
import { inviteEventOutbox1787097600000 as SqliteMigration } from '../../migrations/sqlite/1787097600000-invite-event-outbox'

describe.each([
  ['mysql', new MySqlMigration()],
  ['sqlite', new SqliteMigration()],
] as const)('invite event outbox %s migration', (_dialect, migration) => {
  it('adds the table and all dispatch, lease, retention, and fanout indexes', async () => {
    const statements: string[] = []
    const queryRunner = { query: jest.fn(async (sql: string) => statements.push(sql)) } as unknown as QueryRunner

    await migration.up(queryRunner)

    const sql = statements.join('\n').toLowerCase()
    expect(sql).toContain('invite_event_outbox')
    expect(sql).toContain('index_invite_event_outbox_dispatch')
    expect(sql).toContain('index_invite_event_outbox_stale_lease')
    expect(sql).toContain('index_invite_event_outbox_published_at')
    expect(sql).toContain('index_invite_event_outbox_fanout_hash')
    expect(sql).toContain('last_error_code')
    expect(sql).toContain('last_attempt_at_timestamp')
  })

  it('removes only the newly introduced table on down', async () => {
    const statements: string[] = []
    const queryRunner = { query: jest.fn(async (sql: string) => statements.push(sql)) } as unknown as QueryRunner

    await migration.down(queryRunner)

    expect(statements).toHaveLength(1)
    expect(statements[0]?.toLowerCase()).toMatch(/^drop table [`"]invite_event_outbox[`"]$/)
  })
})

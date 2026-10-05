import { QueryRunner } from 'typeorm'

import { magicLinkAttemptCap1791158400000 as MySqlMigration } from '../../migrations/mysql/1791158400000-magic-link-attempt-cap'
import { magicLinkAttemptCap1791158400000 as SqliteMigration } from '../../migrations/sqlite/1791158400000-magic-link-attempt-cap'

/**
 * Standard Red Notes: the per-code attempt counter needs a column, and the column
 * has to arrive the same way every other auth column does — one statement per
 * dialect, `NOT NULL DEFAULT 0` so outstanding codes issued before the migration
 * keep their full allowance instead of reading as exhausted.
 */
describe.each([
  ['mysql', new MySqlMigration()],
  ['sqlite', new SqliteMigration()],
] as const)('magic-link attempt cap %s migration', (_dialect, migration) => {
  const record = (): { statements: string[]; queryRunner: QueryRunner } => {
    const statements: string[] = []

    return {
      statements,
      queryRunner: { query: jest.fn(async (sql: string) => statements.push(sql)) } as unknown as QueryRunner,
    }
  }

  it('adds failed_attempts to magic_link_tokens, not null and defaulted to zero', async () => {
    const { statements, queryRunner } = record()

    await migration.up(queryRunner)

    expect(statements).toHaveLength(1)
    const sql = (statements[0] as string).toLowerCase()
    expect(sql).toContain('alter table')
    expect(sql).toContain('magic_link_tokens')
    expect(sql).toContain('failed_attempts')
    expect(sql).toContain('not null')
    expect(sql).toContain('default 0')
  })

  it('removes only that column on down', async () => {
    const { statements, queryRunner } = record()

    await migration.down(queryRunner)

    expect(statements).toHaveLength(1)
    expect((statements[0] as string).toLowerCase()).toMatch(
      /^alter table [`"]magic_link_tokens[`"] drop column [`"]failed_attempts[`"]$/,
    )
  })
})

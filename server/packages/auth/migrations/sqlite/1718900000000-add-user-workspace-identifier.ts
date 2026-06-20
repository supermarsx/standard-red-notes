import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Standard Red Notes: "multiple accounts per email" (workspaces) — sqlite.
 *
 * Adds users.workspace_identifier with a database default of 'default' and a
 * composite UNIQUE index on (email, workspace_identifier).
 *
 * SQLite supports ADD COLUMN with a constant default and CREATE UNIQUE INDEX
 * directly, so no table rebuild is required. The DEFAULT 'default' backfills
 * every existing row; because email was historically unique, every existing
 * (email, 'default') pair is unique and the composite unique index holds.
 *
 * Safety / default-OFF no-op: with WORKSPACES_PER_EMAIL_ENABLED OFF the server
 * always writes 'default', making the composite index equivalent to the old
 * one-account-per-email guarantee.
 *
 * NOT run automatically; an operator runs migrations as with every other
 * migration in this package.
 */
export class AddUserWorkspaceIdentifier1718900000000 implements MigrationInterface {
  name = 'AddUserWorkspaceIdentifier1718900000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "ALTER TABLE `users` ADD `workspace_identifier` varchar(255) NOT NULL DEFAULT ('default')",
    )
    // Defensive backfill in case any row was inserted with an explicit NULL.
    await queryRunner.query(
      "UPDATE `users` SET `workspace_identifier` = 'default' WHERE `workspace_identifier` IS NULL",
    )
    await queryRunner.query(
      'CREATE UNIQUE INDEX "index_users_on_email_and_workspace_identifier" ON "users" ("email", "workspace_identifier")',
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "index_users_on_email_and_workspace_identifier"')
    await queryRunner.query('ALTER TABLE `users` DROP COLUMN `workspace_identifier`')
  }
}

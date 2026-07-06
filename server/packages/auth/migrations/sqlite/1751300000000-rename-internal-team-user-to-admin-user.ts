import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Rename the admin role from the legacy 'INTERNAL_TEAM_USER' name to the
 * canonical 'ADMIN_USER'. The role is referenced everywhere else by its UUID
 * (role_permissions.role_uuid, user_roles.role_uuid) — only roles.name holds
 * the string — so renaming the name in place is safe and non-destructive.
 *
 * Naturally idempotent: on an already-renamed / fresh-then-renamed DB the WHERE
 * clause matches zero rows and the statement is a no-op. Runs on both existing
 * DBs (renames the seeded row) and fresh installs (the seed inserts
 * INTERNAL_TEAM_USER first, then this migration renames it to ADMIN_USER).
 *
 * NOTE: string literals are SINGLE-quoted (correct SQL literals in SQLite with
 * DQS off); the `roles` identifier is backtick-quoted like the seed migration.
 */
export class renameInternalTeamUserToAdminUser1751300000000 implements MigrationInterface {
  name = 'renameInternalTeamUserToAdminUser1751300000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("UPDATE `roles` SET name = 'ADMIN_USER' WHERE name = 'INTERNAL_TEAM_USER'")
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("UPDATE `roles` SET name = 'INTERNAL_TEAM_USER' WHERE name = 'ADMIN_USER'")
  }
}

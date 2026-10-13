import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Standard Red Notes: SQLite counterpart of the MySQL migration of the same
 * timestamp; see that file for why the constraint exists and why duplicates
 * are removed before the index is created.
 *
 * SQLite has no multi-table DELETE but does allow the target table in a
 * subquery, so the same strict keep-one order (designated survivor, then most
 * recently updated, then lowest uuid) is a correlated EXISTS -- as in the
 * syncing-server's sqlite `1787100000000-add-unique-shared-vault-membership`.
 */
export class uniqueAuthSharedVaultMembership1791936000000 implements MigrationInterface {
  name = 'uniqueAuthSharedVaultMembership1791936000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DELETE FROM "auth_shared_vault_users" WHERE EXISTS (' +
        'SELECT 1 FROM "auth_shared_vault_users" AS "keep" ' +
        'WHERE "keep"."shared_vault_uuid" = "auth_shared_vault_users"."shared_vault_uuid" ' +
        'AND "keep"."user_uuid" = "auth_shared_vault_users"."user_uuid" ' +
        'AND ("keep"."is_designated_survivor" > "auth_shared_vault_users"."is_designated_survivor" ' +
        'OR ("keep"."is_designated_survivor" = "auth_shared_vault_users"."is_designated_survivor" ' +
        'AND "keep"."updated_at_timestamp" > "auth_shared_vault_users"."updated_at_timestamp") ' +
        'OR ("keep"."is_designated_survivor" = "auth_shared_vault_users"."is_designated_survivor" ' +
        'AND "keep"."updated_at_timestamp" = "auth_shared_vault_users"."updated_at_timestamp" ' +
        'AND "keep"."uuid" < "auth_shared_vault_users"."uuid")))',
    )

    await queryRunner.query(
      'CREATE UNIQUE INDEX "unique_membership_on_auth_shared_vault_users" ON "auth_shared_vault_users" ("shared_vault_uuid", "user_uuid")',
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "unique_membership_on_auth_shared_vault_users"')
  }
}

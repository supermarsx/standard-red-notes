import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * SQLite counterpart of the MySQL migration of the same timestamp. See that file for why the
 * constraint exists and why de-duplication has to run before the index is created.
 *
 * SQLite has no multi-table DELETE but also no restriction on naming the target table in a
 * subquery, so the same strict total order (designated survivor, then most recently updated, then
 * lowest uuid) is expressed as a correlated EXISTS.
 */
export class AddUniqueSharedVaultMembership1787100000000 implements MigrationInterface {
  name = 'AddUniqueSharedVaultMembership1787100000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DELETE FROM "shared_vault_users" WHERE EXISTS (' +
        'SELECT 1 FROM "shared_vault_users" AS "keep" ' +
        'WHERE "keep"."shared_vault_uuid" = "shared_vault_users"."shared_vault_uuid" ' +
        'AND "keep"."user_uuid" = "shared_vault_users"."user_uuid" ' +
        'AND ("keep"."is_designated_survivor" > "shared_vault_users"."is_designated_survivor" ' +
        'OR ("keep"."is_designated_survivor" = "shared_vault_users"."is_designated_survivor" ' +
        'AND "keep"."updated_at_timestamp" > "shared_vault_users"."updated_at_timestamp") ' +
        'OR ("keep"."is_designated_survivor" = "shared_vault_users"."is_designated_survivor" ' +
        'AND "keep"."updated_at_timestamp" = "shared_vault_users"."updated_at_timestamp" ' +
        'AND "keep"."uuid" < "shared_vault_users"."uuid")))',
    )

    await queryRunner.query(
      'CREATE UNIQUE INDEX "unique_membership_on_shared_vault_users" ON "shared_vault_users" ("shared_vault_uuid", "user_uuid")',
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "unique_membership_on_shared_vault_users"')
  }
}

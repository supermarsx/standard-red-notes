import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Standard Red Notes: one row per membership in auth's mirror of shared-vault
 * membership.
 *
 * `auth_shared_vault_users` had no uniqueness on (shared_vault_uuid, user_uuid)
 * and `AddSharedVaultUser` inserted blindly, so a redelivered
 * `USER_ADDED_TO_SHARED_VAULT` (SQS is at-least-once) wrote a second row. The
 * removal deleted ONE row, so the duplicate survived it and the removed member
 * stayed in `belongs_to_shared_vaults` -- which the revisions service trusts as
 * its only authorization scope.
 *
 * Same shape and keep-one rule as the syncing-server's
 * `1787100000000-add-unique-shared-vault-membership`: de-duplicate FIRST (a
 * blind `CREATE UNIQUE INDEX` on a live table with duplicates would abort the
 * whole migration run), keeping per pair the designated survivor, then the most
 * recently updated row, then the lowest uuid. A multi-table DELETE, because
 * MySQL/MariaDB refuse a DELETE whose subquery names the target table.
 */
export class uniqueAuthSharedVaultMembership1791936000000 implements MigrationInterface {
  name = 'uniqueAuthSharedVaultMembership1791936000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DELETE `dup` FROM `auth_shared_vault_users` `dup` ' +
        'INNER JOIN `auth_shared_vault_users` `keep` ' +
        'ON `keep`.`shared_vault_uuid` = `dup`.`shared_vault_uuid` ' +
        'AND `keep`.`user_uuid` = `dup`.`user_uuid` ' +
        'AND (`keep`.`is_designated_survivor` > `dup`.`is_designated_survivor` ' +
        'OR (`keep`.`is_designated_survivor` = `dup`.`is_designated_survivor` ' +
        'AND `keep`.`updated_at_timestamp` > `dup`.`updated_at_timestamp`) ' +
        'OR (`keep`.`is_designated_survivor` = `dup`.`is_designated_survivor` ' +
        'AND `keep`.`updated_at_timestamp` = `dup`.`updated_at_timestamp` ' +
        'AND `keep`.`uuid` < `dup`.`uuid`))',
    )

    await queryRunner.query(
      'CREATE UNIQUE INDEX `unique_membership_on_auth_shared_vault_users` ON `auth_shared_vault_users` (`shared_vault_uuid`, `user_uuid`)',
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX `unique_membership_on_auth_shared_vault_users` ON `auth_shared_vault_users`')
  }
}

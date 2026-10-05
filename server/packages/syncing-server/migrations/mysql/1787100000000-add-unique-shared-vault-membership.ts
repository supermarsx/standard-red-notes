import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * `shared_vault_users` had no uniqueness on (shared_vault_uuid, user_uuid), and
 * `AddUserToSharedVault` wrote a new row without checking for an existing membership. Removal reads
 * ONE row (`findByUserUuidAndSharedVaultUuid` -> `getOne()`) and deletes it, so a second row for the
 * same member would survive the removal and leave a revoked user inside the vault.
 *
 * De-duplication runs BEFORE the index is created: on a live database a blind `CREATE UNIQUE INDEX`
 * would abort the whole migration run, which is worse than no constraint at all.
 *
 * The keep-one rule is a strict total order per (vault, user): designated survivor first, then the
 * most recently updated row, then the lowest uuid as a deterministic tie-break. Expressed as a
 * multi-table DELETE (delete every row for which a strictly better row exists in the same group)
 * rather than `WHERE uuid NOT IN (SELECT ... FROM shared_vault_users)`, because MySQL and MariaDB
 * reject a DELETE whose subquery names the target table (ERROR 1093 / "specified twice").
 */
export class AddUniqueSharedVaultMembership1787100000000 implements MigrationInterface {
  name = 'AddUniqueSharedVaultMembership1787100000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DELETE `dup` FROM `shared_vault_users` `dup` ' +
        'INNER JOIN `shared_vault_users` `keep` ' +
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
      'CREATE UNIQUE INDEX `unique_membership_on_shared_vault_users` ON `shared_vault_users` (`shared_vault_uuid`, `user_uuid`)',
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX `unique_membership_on_shared_vault_users` ON `shared_vault_users`')
  }
}

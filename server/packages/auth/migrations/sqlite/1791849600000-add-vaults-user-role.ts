import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Standard Red Notes: give the all-in-one (sqlite) database the VAULTS_USER role
 * it has never had.
 *
 * MySQL got this row from `1694157482134-add_vaults_user`. That migration was
 * never ported to sqlite, so on the all-in-one container the role is one of the
 * four the server calls canonical (`CANONICAL_ADMIN_ROLES`) and one the database
 * does not contain. Measured on a running all-in-one:
 *
 *   - the Admin pane's Roles tab says "the system exposes exactly four roles" and
 *     lists three;
 *   - `srn-admin roles grant <user> VAULTS_USER` prints "Granted VAULTS_USER" and
 *     exits 0 while the account's roles stay exactly as they were, because there
 *     is no row to attach;
 *   - the multi-container build, on the same commit, lists four and grants it.
 *
 * The uuid is the one MySQL uses, so the role is the same role on both.
 *
 * Idempotent, and it leaves a database alone that already has the role: an
 * operator may have inserted one by hand, and accounts may hold it.
 */
export class addVaultsUserRole1791849600000 implements MigrationInterface {
  name = 'addVaultsUserRole1791849600000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "INSERT INTO `roles` (uuid, name, version) SELECT '35669f45-a2d8-4172-bdab-b7b3d42044ce', 'VAULTS_USER', 1 " +
        "WHERE NOT EXISTS (SELECT 1 FROM `roles` WHERE name = 'VAULTS_USER' OR uuid = '35669f45-a2d8-4172-bdab-b7b3d42044ce')",
    )
  }

  // Deliberately nothing, as on MySQL: accounts and groups may hold the role by
  // now, and taking the row away would strand them.
  public async down(): Promise<void> {
    return
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Standard Red Notes: reversible admin SUSPENSION — a neutral administrative
 * hold, first-class and SEPARATE from a ban (see User.isSuspended /
 * isAccessBlocked). Adds the suspended flag, an audit timestamp and an optional
 * reason. Defaults to not-suspended so every existing row is unaffected.
 */
export class AddUserSuspended1752300000000 implements MigrationInterface {
  name = 'AddUserSuspended1752300000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `users` ADD `suspended` tinyint(1) NOT NULL DEFAULT 0')
    await queryRunner.query('ALTER TABLE `users` ADD `suspended_at` datetime NULL')
    await queryRunner.query('ALTER TABLE `users` ADD `suspended_reason` varchar(255) NULL')
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `users` DROP COLUMN `suspended_reason`')
    await queryRunner.query('ALTER TABLE `users` DROP COLUMN `suspended_at`')
    await queryRunner.query('ALTER TABLE `users` DROP COLUMN `suspended`')
  }
}

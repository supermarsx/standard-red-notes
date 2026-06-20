import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddUserBanned1718800000000 implements MigrationInterface {
  name = 'AddUserBanned1718800000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `users` ADD `banned` tinyint NOT NULL DEFAULT (0)')
    await queryRunner.query('ALTER TABLE `users` ADD `banned_at` datetime')
    await queryRunner.query('ALTER TABLE `users` ADD `ban_reason` varchar(255)')
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `users` DROP COLUMN `ban_reason`')
    await queryRunner.query('ALTER TABLE `users` DROP COLUMN `banned_at`')
    await queryRunner.query('ALTER TABLE `users` DROP COLUMN `banned`')
  }
}

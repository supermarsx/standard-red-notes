import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Standard Red Notes: richer account bans. Extends the existing simple-ban
 * columns (banned / banned_at / ban_reason) with the ban KIND and a temporary
 * ban's expiry. Legacy banned rows leave `ban_type` NULL and are interpreted as
 * permanent (see User.effectiveBanType), so existing bans are unaffected.
 */
export class AddUserBanType1751100000000 implements MigrationInterface {
  name = 'AddUserBanType1751100000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `users` ADD `ban_type` varchar(20) NULL')
    await queryRunner.query('ALTER TABLE `users` ADD `banned_until` datetime NULL')
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `users` DROP COLUMN `banned_until`')
    await queryRunner.query('ALTER TABLE `users` DROP COLUMN `ban_type`')
  }
}

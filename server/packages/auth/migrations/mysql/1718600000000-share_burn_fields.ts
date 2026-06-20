import { MigrationInterface, QueryRunner } from 'typeorm'

export class shareBurnFields1718600000000 implements MigrationInterface {
  name = 'shareBurnFields1718600000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `shares` ADD `one_time_view` tinyint NOT NULL DEFAULT 0')
    await queryRunner.query('ALTER TABLE `shares` ADD `view_expires_minutes` int NULL')
    await queryRunner.query('ALTER TABLE `shares` ADD `first_opened_at` bigint NULL')
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `shares` DROP COLUMN `first_opened_at`')
    await queryRunner.query('ALTER TABLE `shares` DROP COLUMN `view_expires_minutes`')
    await queryRunner.query('ALTER TABLE `shares` DROP COLUMN `one_time_view`')
  }
}

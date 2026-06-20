import { MigrationInterface, QueryRunner } from 'typeorm'

export class deadManSwitchesRetry1718600000000 implements MigrationInterface {
  name = 'deadManSwitchesRetry1718600000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `dead_man_switches` ADD `send_attempts` int NOT NULL DEFAULT 0',
    )
    await queryRunner.query('ALTER TABLE `dead_man_switches` ADD `next_attempt_at` bigint NULL')
    await queryRunner.query('ALTER TABLE `dead_man_switches` ADD `last_attempt_at` bigint NULL')
    await queryRunner.query('ALTER TABLE `dead_man_switches` ADD `last_error` text NULL')
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `dead_man_switches` DROP COLUMN `last_error`')
    await queryRunner.query('ALTER TABLE `dead_man_switches` DROP COLUMN `last_attempt_at`')
    await queryRunner.query('ALTER TABLE `dead_man_switches` DROP COLUMN `next_attempt_at`')
    await queryRunner.query('ALTER TABLE `dead_man_switches` DROP COLUMN `send_attempts`')
  }
}

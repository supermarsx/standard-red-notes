import { MigrationInterface, QueryRunner } from 'typeorm'

export class deadManSwitches1718500000000 implements MigrationInterface {
  name = 'deadManSwitches1718500000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE `dead_man_switches` (`uuid` varchar(36) NOT NULL, `user_uuid` varchar(36) NOT NULL, `recipient_email` varchar(255) NOT NULL, `share_url` text NOT NULL, `message` text NULL, `interval_days` int NOT NULL, `deadline` bigint NOT NULL, `triggered` tinyint NOT NULL DEFAULT 0, `last_check_in_at` bigint NULL, `created_at` bigint NOT NULL, INDEX `index_dead_man_switches_on_user_uuid` (`user_uuid`), PRIMARY KEY (`uuid`)) ENGINE=InnoDB',
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX `index_dead_man_switches_on_user_uuid` ON `dead_man_switches`')
    await queryRunner.query('DROP TABLE `dead_man_switches`')
  }
}

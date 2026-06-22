import { MigrationInterface, QueryRunner } from 'typeorm'

export class webhooksAndAuditLog1718300000000 implements MigrationInterface {
  name = 'webhooksAndAuditLog1718300000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE `webhooks` (`uuid` varchar(36) NOT NULL, `user_uuid` varchar(36) NULL, `target_url` varchar(2048) NOT NULL, `events` text NOT NULL, `secret` varchar(255) NOT NULL, `enabled` tinyint NOT NULL DEFAULT 1, `created_at` bigint NOT NULL, INDEX `index_webhooks_on_user_uuid` (`user_uuid`), PRIMARY KEY (`uuid`)) ENGINE=InnoDB',
    )

    await queryRunner.query(
      'CREATE TABLE `audit_log` (`uuid` varchar(36) NOT NULL, `actor_uuid` varchar(36) NULL, `action` varchar(255) NOT NULL, `target_type` varchar(255) NULL, `target_uuid` varchar(36) NULL, `ip` varchar(45) NULL, `metadata` text NULL, `created_at` bigint NOT NULL, INDEX `index_audit_log_on_actor_uuid` (`actor_uuid`), INDEX `index_audit_log_on_action` (`action`), INDEX `index_audit_log_on_created_at` (`created_at`), PRIMARY KEY (`uuid`)) ENGINE=InnoDB',
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX `index_audit_log_on_created_at` ON `audit_log`')
    await queryRunner.query('DROP INDEX `index_audit_log_on_action` ON `audit_log`')
    await queryRunner.query('DROP INDEX `index_audit_log_on_actor_uuid` ON `audit_log`')
    await queryRunner.query('DROP TABLE `audit_log`')

    await queryRunner.query('DROP INDEX `index_webhooks_on_user_uuid` ON `webhooks`')
    await queryRunner.query('DROP TABLE `webhooks`')
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm'

export class pendingMfaApprovals1718700000001 implements MigrationInterface {
  name = 'pendingMfaApprovals1718700000001'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "CREATE TABLE `pending_mfa_approvals` (`uuid` varchar(36) NOT NULL, `user_uuid` varchar(36) NOT NULL, `challenge_id` varchar(255) NOT NULL, `status` varchar(16) NOT NULL DEFAULT 'pending', `requesting_user_agent` text NULL, `requesting_ip_address` varchar(255) NULL, `created_at` bigint NOT NULL, `expires_at` bigint NOT NULL, `consumed` tinyint NOT NULL DEFAULT 0, INDEX `index_pending_mfa_approvals_on_user_uuid` (`user_uuid`), INDEX `index_pending_mfa_approvals_on_challenge_id` (`challenge_id`), PRIMARY KEY (`uuid`)) ENGINE=InnoDB",
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX `index_pending_mfa_approvals_on_challenge_id` ON `pending_mfa_approvals`',
    )
    await queryRunner.query('DROP INDEX `index_pending_mfa_approvals_on_user_uuid` ON `pending_mfa_approvals`')
    await queryRunner.query('DROP TABLE `pending_mfa_approvals`')
  }
}

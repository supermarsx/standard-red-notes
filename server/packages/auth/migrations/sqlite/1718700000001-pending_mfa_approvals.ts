import { MigrationInterface, QueryRunner } from 'typeorm'

export class pendingMfaApprovals1718700000001 implements MigrationInterface {
  name = 'pendingMfaApprovals1718700000001'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE "pending_mfa_approvals" ("uuid" varchar PRIMARY KEY NOT NULL, "user_uuid" varchar(36) NOT NULL, "challenge_id" varchar(255) NOT NULL, "status" varchar(16) NOT NULL DEFAULT (\'pending\'), "requesting_user_agent" text, "requesting_ip_address" varchar(255), "created_at" bigint NOT NULL, "expires_at" bigint NOT NULL, "consumed" boolean NOT NULL DEFAULT (0))',
    )
    await queryRunner.query(
      'CREATE INDEX "index_pending_mfa_approvals_on_user_uuid" ON "pending_mfa_approvals" ("user_uuid")',
    )
    await queryRunner.query(
      'CREATE INDEX "index_pending_mfa_approvals_on_challenge_id" ON "pending_mfa_approvals" ("challenge_id")',
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "index_pending_mfa_approvals_on_challenge_id"')
    await queryRunner.query('DROP INDEX "index_pending_mfa_approvals_on_user_uuid"')
    await queryRunner.query('DROP TABLE "pending_mfa_approvals"')
  }
}

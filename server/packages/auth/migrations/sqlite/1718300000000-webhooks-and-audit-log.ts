import { MigrationInterface, QueryRunner } from 'typeorm'

export class webhooksAndAuditLog1718300000000 implements MigrationInterface {
  name = 'webhooksAndAuditLog1718300000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE "webhooks" ("uuid" varchar PRIMARY KEY NOT NULL, "user_uuid" varchar(36), "target_url" varchar(2048) NOT NULL, "events" text NOT NULL, "secret" varchar(255) NOT NULL, "enabled" boolean NOT NULL DEFAULT (1), "created_at" bigint NOT NULL)',
    )
    await queryRunner.query('CREATE INDEX "index_webhooks_on_user_uuid" ON "webhooks" ("user_uuid")')

    await queryRunner.query(
      'CREATE TABLE "audit_log" ("uuid" varchar PRIMARY KEY NOT NULL, "actor_uuid" varchar(36), "action" varchar(255) NOT NULL, "target_type" varchar(255), "target_uuid" varchar(36), "ip" varchar(45), "metadata" text, "created_at" bigint NOT NULL)',
    )
    await queryRunner.query('CREATE INDEX "index_audit_log_on_actor_uuid" ON "audit_log" ("actor_uuid")')
    await queryRunner.query('CREATE INDEX "index_audit_log_on_action" ON "audit_log" ("action")')
    await queryRunner.query('CREATE INDEX "index_audit_log_on_created_at" ON "audit_log" ("created_at")')
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "index_audit_log_on_created_at"')
    await queryRunner.query('DROP INDEX "index_audit_log_on_action"')
    await queryRunner.query('DROP INDEX "index_audit_log_on_actor_uuid"')
    await queryRunner.query('DROP TABLE "audit_log"')

    await queryRunner.query('DROP INDEX "index_webhooks_on_user_uuid"')
    await queryRunner.query('DROP TABLE "webhooks"')
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddSyncCommandJournal1787000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "sync_commands" (
        "uuid" varchar(36) PRIMARY KEY NOT NULL,
        "user_uuid" varchar(36) NOT NULL,
        "session_uuid" varchar(36) NOT NULL,
        "command_id" varchar(128) NOT NULL,
        "request_digest" varchar(64) NOT NULL,
        "status" varchar(16) NOT NULL,
        "response_json" text,
        "execution_token" varchar(36),
        "created_at_timestamp" bigint NOT NULL,
        "updated_at_timestamp" bigint NOT NULL,
        "expires_at_timestamp" bigint NOT NULL
      )
    `)
    await queryRunner.query(
      'CREATE UNIQUE INDEX "index_sync_commands_scope_command" ON "sync_commands" ("user_uuid", "session_uuid", "command_id")',
    )
    await queryRunner.query('CREATE INDEX "index_sync_commands_expires_at" ON "sync_commands" ("expires_at_timestamp")')

    await queryRunner.query(`
      CREATE TABLE "sync_command_outbox" (
        "uuid" varchar(36) PRIMARY KEY NOT NULL,
        "event_json" text NOT NULL,
        "status" varchar(16) NOT NULL,
        "attempts" integer NOT NULL DEFAULT 0,
        "available_at_timestamp" bigint NOT NULL,
        "locked_at_timestamp" bigint,
        "lock_token" varchar(36),
        "created_at_timestamp" bigint NOT NULL,
        "updated_at_timestamp" bigint NOT NULL,
        "published_at_timestamp" bigint
      )
    `)
    await queryRunner.query(
      'CREATE INDEX "index_sync_command_outbox_dispatch" ON "sync_command_outbox" ("status", "available_at_timestamp")',
    )
    await queryRunner.query(
      'CREATE INDEX "index_sync_command_outbox_published_at" ON "sync_command_outbox" ("published_at_timestamp")',
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "sync_command_outbox"')
    await queryRunner.query('DROP TABLE IF EXISTS "sync_commands"')
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm'

export class inviteEventOutbox1787097600000 implements MigrationInterface {
  name = 'inviteEventOutbox1787097600000'

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE "invite_event_outbox" ("uuid" varchar(36) NOT NULL, "event_json" text NOT NULL, "affected_user_uuids_json" text NOT NULL, "fanout_hash" varchar(64) NOT NULL, "status" varchar(16) NOT NULL, "attempts" integer NOT NULL DEFAULT 0, "available_at_timestamp" bigint NOT NULL, "locked_at_timestamp" bigint, "lock_token" varchar(36), "last_attempt_at_timestamp" bigint, "last_error_code" varchar(64), "created_at_timestamp" bigint NOT NULL, "updated_at_timestamp" bigint NOT NULL, "published_at_timestamp" bigint, PRIMARY KEY ("uuid"))',
    )
    await queryRunner.query(
      'CREATE INDEX "index_invite_event_outbox_dispatch" ON "invite_event_outbox" ("status", "available_at_timestamp")',
    )
    await queryRunner.query(
      'CREATE INDEX "index_invite_event_outbox_stale_lease" ON "invite_event_outbox" ("status", "locked_at_timestamp")',
    )
    await queryRunner.query(
      'CREATE INDEX "index_invite_event_outbox_published_at" ON "invite_event_outbox" ("published_at_timestamp")',
    )
    await queryRunner.query(
      'CREATE INDEX "index_invite_event_outbox_fanout_hash" ON "invite_event_outbox" ("fanout_hash")',
    )
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "invite_event_outbox"')
  }
}

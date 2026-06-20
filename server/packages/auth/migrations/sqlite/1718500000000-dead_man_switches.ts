import { MigrationInterface, QueryRunner } from 'typeorm'

export class deadManSwitches1718500000000 implements MigrationInterface {
  name = 'deadManSwitches1718500000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE "dead_man_switches" ("uuid" varchar PRIMARY KEY NOT NULL, "user_uuid" varchar(36) NOT NULL, "recipient_email" varchar(255) NOT NULL, "share_url" text NOT NULL, "message" text, "interval_days" integer NOT NULL, "deadline" bigint NOT NULL, "triggered" boolean NOT NULL DEFAULT (0), "last_check_in_at" bigint, "created_at" bigint NOT NULL)',
    )
    await queryRunner.query(
      'CREATE INDEX "index_dead_man_switches_on_user_uuid" ON "dead_man_switches" ("user_uuid")',
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "index_dead_man_switches_on_user_uuid"')
    await queryRunner.query('DROP TABLE "dead_man_switches"')
  }
}

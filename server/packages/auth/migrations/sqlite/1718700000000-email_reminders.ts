import { MigrationInterface, QueryRunner } from 'typeorm'

export class emailReminders1718700000000 implements MigrationInterface {
  name = 'emailReminders1718700000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE "email_reminders" ("uuid" varchar PRIMARY KEY NOT NULL, "user_uuid" varchar(36) NOT NULL, "due_at" bigint NOT NULL, "message" text NOT NULL, "sent" boolean NOT NULL DEFAULT (0), "created_at" bigint NOT NULL)',
    )
    await queryRunner.query(
      'CREATE INDEX "index_email_reminders_on_user_uuid" ON "email_reminders" ("user_uuid")',
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "index_email_reminders_on_user_uuid"')
    await queryRunner.query('DROP TABLE "email_reminders"')
  }
}

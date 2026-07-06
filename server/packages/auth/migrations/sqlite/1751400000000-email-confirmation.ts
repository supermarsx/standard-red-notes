import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Standard Red Notes: EMAIL CONFIRMATION (part 2 of registration).
 *
 * Adds the single-use confirmation-token table plus the `email_confirmed` /
 * `email_confirmed_at` columns on `users`, and BACKFILLS every existing user to
 * email_confirmed = 1 so enabling the feature later only affects NEW signups.
 *
 * NOTE: identifiers are double-quoted (correct in SQLite with DQS off); there
 * are NO string literals in these statements, so nothing needs single-quoting.
 * Nullable/defaulted columns add cleanly without a table rebuild.
 */
export class emailConfirmation1751400000000 implements MigrationInterface {
  name = 'emailConfirmation1751400000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE "email_confirmation_tokens" ("uuid" varchar PRIMARY KEY NOT NULL, "user_uuid" varchar(255) NOT NULL, "email" varchar(255) NOT NULL, "hashed_token" varchar(255) NOT NULL, "expires_at" datetime NOT NULL, "consumed" boolean NOT NULL DEFAULT (0), "created_at" datetime NOT NULL)',
    )
    await queryRunner.query(
      'CREATE INDEX "index_email_confirmation_tokens_on_user_uuid" ON "email_confirmation_tokens" ("user_uuid")',
    )
    await queryRunner.query(
      'CREATE INDEX "index_email_confirmation_tokens_on_hashed_token" ON "email_confirmation_tokens" ("hashed_token")',
    )

    await queryRunner.query('ALTER TABLE "users" ADD "email_confirmed" boolean NOT NULL DEFAULT (1)')
    await queryRunner.query('ALTER TABLE "users" ADD "email_confirmed_at" datetime')

    // Backfill existing users to confirmed (the column default is 1 too, but the
    // explicit UPDATE documents intent and is safe/idempotent).
    await queryRunner.query('UPDATE "users" SET "email_confirmed" = 1')
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "users" DROP COLUMN "email_confirmed_at"')
    await queryRunner.query('ALTER TABLE "users" DROP COLUMN "email_confirmed"')
    await queryRunner.query('DROP INDEX "index_email_confirmation_tokens_on_hashed_token"')
    await queryRunner.query('DROP INDEX "index_email_confirmation_tokens_on_user_uuid"')
    await queryRunner.query('DROP TABLE "email_confirmation_tokens"')
  }
}

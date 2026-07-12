import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Standard Red Notes: APPROVAL / WAITLIST QUEUE (SQLite). See the mysql
 * counterpart. A pending user is a real user row whose access is gated until an
 * admin approves. Defaults to approved = 1 and BACKFILLS existing rows so
 * enabling the feature later only gates NEW signups.
 *
 * NOTE: identifiers are double-quoted (correct in SQLite with DQS off); there are
 * NO string literals. Nullable/defaulted columns add cleanly without a rebuild.
 * UNIQUE timestamp 1752600000000.
 */
export class AddUserApproved1752600000000 implements MigrationInterface {
  name = 'AddUserApproved1752600000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "users" ADD "approved" boolean NOT NULL DEFAULT (1)')
    await queryRunner.query('ALTER TABLE "users" ADD "approved_at" datetime')
    await queryRunner.query('ALTER TABLE "users" ADD "approval_note" varchar(255)')

    // Backfill existing users to approved (the column default is 1 too, but the
    // explicit UPDATE documents intent and is safe/idempotent).
    await queryRunner.query('UPDATE "users" SET "approved" = 1')
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "users" DROP COLUMN "approval_note"')
    await queryRunner.query('ALTER TABLE "users" DROP COLUMN "approved_at"')
    await queryRunner.query('ALTER TABLE "users" DROP COLUMN "approved"')
  }
}

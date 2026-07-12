import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Standard Red Notes: APPROVAL / WAITLIST QUEUE. A pending user is a REAL user
 * row whose ACCESS is gated until an admin approves (mirrors suspended /
 * emailConfirmed — NOT a separate credential-bearing request table). Adds the
 * `approved` flag plus an audit timestamp and an optional note.
 *
 * Defaults to approved = 1 and BACKFILLS every existing row to 1 so enabling the
 * feature later only ever gates NEW signups and can never lock out an account
 * that predates the feature (mirrors the email-confirmation backfill).
 *
 * UNIQUE timestamp 1752600000000.
 */
export class AddUserApproved1752600000000 implements MigrationInterface {
  name = 'AddUserApproved1752600000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `users` ADD `approved` tinyint NOT NULL DEFAULT 1')
    await queryRunner.query('ALTER TABLE `users` ADD `approved_at` datetime NULL')
    await queryRunner.query('ALTER TABLE `users` ADD `approval_note` varchar(255) NULL')

    // Backfill: every existing account is treated as already approved so enabling
    // the feature only gates NEW signups. (The column default is 1 too, but the
    // explicit UPDATE documents the intent and is safe/idempotent.)
    await queryRunner.query('UPDATE `users` SET `approved` = 1')
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `users` DROP COLUMN `approval_note`')
    await queryRunner.query('ALTER TABLE `users` DROP COLUMN `approved_at`')
    await queryRunner.query('ALTER TABLE `users` DROP COLUMN `approved`')
  }
}

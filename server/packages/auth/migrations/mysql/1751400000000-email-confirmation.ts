import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Standard Red Notes: EMAIL CONFIRMATION (part 2 of registration).
 *
 * Adds the single-use confirmation-token table plus the `email_confirmed` /
 * `email_confirmed_at` columns on `users`. The feature is OFF by default; this
 * migration BACKFILLS every existing user to email_confirmed = 1 so that turning
 * confirmation on later only ever affects NEW signups and can never lock out an
 * account that predates the feature.
 */
export class emailConfirmation1751400000000 implements MigrationInterface {
  name = 'emailConfirmation1751400000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE `email_confirmation_tokens` (`uuid` varchar(36) NOT NULL, `user_uuid` varchar(255) NOT NULL, `email` varchar(255) NOT NULL, `hashed_token` varchar(255) NOT NULL, `expires_at` datetime NOT NULL, `consumed` tinyint NOT NULL DEFAULT 0, `created_at` datetime NOT NULL, INDEX `index_email_confirmation_tokens_on_user_uuid` (`user_uuid`), INDEX `index_email_confirmation_tokens_on_hashed_token` (`hashed_token`), PRIMARY KEY (`uuid`)) ENGINE=InnoDB',
    )

    await queryRunner.query('ALTER TABLE `users` ADD `email_confirmed` tinyint NOT NULL DEFAULT 1')
    await queryRunner.query('ALTER TABLE `users` ADD `email_confirmed_at` datetime NULL')

    // Backfill: every existing account is treated as already confirmed so enabling
    // the feature only gates NEW signups. (The column default is 1 too, but the
    // explicit UPDATE documents the intent and is safe/idempotent.)
    await queryRunner.query('UPDATE `users` SET `email_confirmed` = 1')
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `users` DROP COLUMN `email_confirmed_at`')
    await queryRunner.query('ALTER TABLE `users` DROP COLUMN `email_confirmed`')
    await queryRunner.query(
      'DROP INDEX `index_email_confirmation_tokens_on_hashed_token` ON `email_confirmation_tokens`',
    )
    await queryRunner.query(
      'DROP INDEX `index_email_confirmation_tokens_on_user_uuid` ON `email_confirmation_tokens`',
    )
    await queryRunner.query('DROP TABLE `email_confirmation_tokens`')
  }
}

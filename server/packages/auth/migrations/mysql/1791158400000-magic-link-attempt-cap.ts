import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Standard Red Notes: the per-code attempt counter for magic-link sign-in codes.
 *
 * A magic-link code is six NUMERIC digits valid for fifteen minutes, and nothing
 * limited how often one could be guessed — a wrong guess left the token fully
 * usable. The counter lives on the token row rather than in a second store so it
 * shares the token's lifetime exactly and survives a restart.
 *
 * `NOT NULL DEFAULT 0` matters: every row that existed before the column did
 * starts with its full allowance. A nullable column would have made pre-existing
 * outstanding codes read as `null` attempts, and any comparison against that
 * would have had to guess which way to fail.
 */
export class magicLinkAttemptCap1791158400000 implements MigrationInterface {
  name = 'magicLinkAttemptCap1791158400000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `magic_link_tokens` ADD `failed_attempts` int NOT NULL DEFAULT 0')
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `magic_link_tokens` DROP COLUMN `failed_attempts`')
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Standard Red Notes: the per-code attempt counter for magic-link sign-in codes.
 * See the MySQL twin for why the counter lives on the token row and why the
 * column is `NOT NULL DEFAULT 0`.
 *
 * NOTE: identifiers are double-quoted (correct in SQLite with DQS off); there are
 * no string literals here, so nothing needs single-quoting. SQLite permits
 * `ADD COLUMN ... NOT NULL` only when a non-null constant default is supplied,
 * which `DEFAULT 0` is, so this adds without a table rebuild.
 */
export class magicLinkAttemptCap1791158400000 implements MigrationInterface {
  name = 'magicLinkAttemptCap1791158400000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "magic_link_tokens" ADD "failed_attempts" integer NOT NULL DEFAULT 0')
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "magic_link_tokens" DROP COLUMN "failed_attempts"')
  }
}

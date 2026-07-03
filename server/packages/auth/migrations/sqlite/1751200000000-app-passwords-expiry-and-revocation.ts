import { MigrationInterface, QueryRunner } from 'typeorm'

export class appPasswordsExpiryAndRevocation1751200000000 implements MigrationInterface {
  name = 'appPasswordsExpiryAndRevocation1751200000000'

  // NOTE: identifiers are double-quoted (correct in SQLite with DQS off); there
  // are no string literals here, so nothing needs single-quoting. Nullable
  // datetime columns add cleanly without a table rebuild.
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "app_passwords" ADD "expires_at" datetime')
    await queryRunner.query('ALTER TABLE "app_passwords" ADD "revoked_at" datetime')
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "app_passwords" DROP COLUMN "revoked_at"')
    await queryRunner.query('ALTER TABLE "app_passwords" DROP COLUMN "expires_at"')
  }
}

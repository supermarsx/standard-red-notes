import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Standard Red Notes: OPTIONAL, OFF-BY-DEFAULT account/password recovery escrow.
 *
 * The escrow itself does NOT need a dedicated table: it is persisted through the
 * existing generic `settings` table under the setting name
 * `ACCOUNT_RECOVERY_ESCROW` (see SettingName.AccountRecoveryEscrow). The value is
 * a CLIENT-SIDE ciphertext blob (the account master key encrypted under a key
 * derived from a high-entropy recovery code that is shown to the user once and
 * never transmitted to the server). The server cannot decrypt it.
 *
 * This migration is intentionally a no-op on the schema. It exists only to record
 * the feature in the migration history following the repository's migration
 * pattern, and to provide a documented anchor for operators. Do not auto-run; run
 * via the normal migration tooling. There is no schema change to roll back.
 */
export class accountRecoveryEscrow1718700000002 implements MigrationInterface {
  name = 'accountRecoveryEscrow1718700000002'

  public async up(_queryRunner: QueryRunner): Promise<void> {
    // No-op: the escrow is stored as a value in the existing `settings` table.
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // No-op: nothing was created in `up`.
  }
}

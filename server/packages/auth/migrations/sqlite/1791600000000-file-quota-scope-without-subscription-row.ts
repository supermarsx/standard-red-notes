import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Standard Red Notes: the SQLite twin of the MySQL migration of the same name —
 * see it for WHY the foreign key goes and what the dead `ON DELETE CASCADE` was
 * protecting. The short version: `FILE_UPLOAD_BYTES_USED` is keyed on a
 * `user_subscriptions` uuid, the default entitlement mode never writes such a
 * row, and the account's bookkeeping now lives under the SYNTHETIC subscription
 * identity the client is already handed (its own user uuid) — which this
 * constraint refused with `FOREIGN KEY constraint failed`, failing the UPLOAD
 * through the in-process event bus rather than merely losing a figure.
 *
 * SQLite cannot drop a constraint in place, so the table is rebuilt: a new table
 * without the constraint, the rows copied, the old table dropped, the new one
 * renamed, and both indexes recreated. That is the same dance the init migration
 * used to ADD this constraint, run backwards.
 *
 * TWO THINGS THIS IS CAREFUL ABOUT.
 *
 *   - `PRAGMA foreign_keys` is NOT touched. Turning it off inside a transaction is
 *     a no-op in SQLite, and turning it off outside one would silently relax every
 *     other constraint in the database for the rest of the connection. The rebuild
 *     does not need it: the rows being copied already satisfy the constraint, and
 *     the NEW table has none.
 *   - `legacy_alter_table` is NOT touched either. With `PRAGMA legacy_alter_table`
 *     off — the modern default — `ALTER TABLE ... RENAME TO` rewrites references to
 *     the renamed table in OTHER objects. Nothing in this schema references
 *     `subscription_settings`, so there is nothing to rewrite; the rename is safe
 *     as issued.
 *
 * Idempotence: the rebuild is guarded on the constraint actually being present in
 * the stored schema, so a database that never had it (restored from a dump, or
 * created by a future consolidated schema) is left exactly alone rather than
 * rebuilt for nothing.
 */
export class fileQuotaScopeWithoutSubscriptionRow1791600000000 implements MigrationInterface {
  name = 'fileQuotaScopeWithoutSubscriptionRow1791600000000'

  private readonly constraintName = 'FK_ad2907de2850d8b531ff23329f3'

  private readonly columns =
    '"uuid", "name", "value", "server_encryption_version", "created_at", "updated_at", "sensitive", "user_subscription_uuid"'

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.storedSchemaHasConstraint(queryRunner))) {
      return
    }

    await queryRunner.query(
      'CREATE TABLE "temporary_subscription_settings" ("uuid" varchar PRIMARY KEY NOT NULL, "name" varchar(255) NOT NULL, "value" text, "server_encryption_version" tinyint NOT NULL DEFAULT (0), "created_at" bigint NOT NULL, "updated_at" bigint NOT NULL, "sensitive" tinyint NOT NULL DEFAULT (0), "user_subscription_uuid" varchar NOT NULL)',
    )
    await queryRunner.query(
      `INSERT INTO "temporary_subscription_settings"(${this.columns}) SELECT ${this.columns} FROM "subscription_settings"`,
    )
    await queryRunner.query('DROP TABLE "subscription_settings"')
    await queryRunner.query('ALTER TABLE "temporary_subscription_settings" RENAME TO "subscription_settings"')
    await this.createIndexes(queryRunner)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await this.storedSchemaHasConstraint(queryRunner)) {
      return
    }

    // See the MySQL twin: a total recorded for an account with no subscription
    // row cannot satisfy the constraint being reinstated, so those rows go first
    // and `fix-quota` re-derives them from the files on disk.
    await queryRunner.query(
      'DELETE FROM "subscription_settings" WHERE "user_subscription_uuid" NOT IN (SELECT "uuid" FROM "user_subscriptions")',
    )
    await queryRunner.query(
      `CREATE TABLE "temporary_subscription_settings" ("uuid" varchar PRIMARY KEY NOT NULL, "name" varchar(255) NOT NULL, "value" text, "server_encryption_version" tinyint NOT NULL DEFAULT (0), "created_at" bigint NOT NULL, "updated_at" bigint NOT NULL, "sensitive" tinyint NOT NULL DEFAULT (0), "user_subscription_uuid" varchar NOT NULL, CONSTRAINT "${this.constraintName}" FOREIGN KEY ("user_subscription_uuid") REFERENCES "user_subscriptions" ("uuid") ON DELETE CASCADE ON UPDATE NO ACTION)`,
    )
    await queryRunner.query(
      `INSERT INTO "temporary_subscription_settings"(${this.columns}) SELECT ${this.columns} FROM "subscription_settings"`,
    )
    await queryRunner.query('DROP TABLE "subscription_settings"')
    await queryRunner.query('ALTER TABLE "temporary_subscription_settings" RENAME TO "subscription_settings"')
    await this.createIndexes(queryRunner)
  }

  private async createIndexes(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE INDEX "index_subcsription_settings_on_updated_at" ON "subscription_settings" ("updated_at")',
    )
    await queryRunner.query(
      'CREATE INDEX "index_settings_on_name_and_user_subscription_uuid" ON "subscription_settings" ("name", "user_subscription_uuid")',
    )
  }

  /**
   * Whether the CONSTRAINT is in the stored CREATE TABLE text.
   *
   * Read from `sqlite_master` rather than from `PRAGMA foreign_key_list`, because
   * the pragma reports the relation without its name and this migration is about
   * one specific named constraint.
   */
  private async storedSchemaHasConstraint(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'subscription_settings'",
    )) as Array<{ sql: string | null }>

    return (rows[0]?.sql ?? '').includes(this.constraintName)
  }
}

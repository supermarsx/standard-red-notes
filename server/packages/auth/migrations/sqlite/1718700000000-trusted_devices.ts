import { MigrationInterface, QueryRunner } from 'typeorm'

export class trustedDevices1718700000000 implements MigrationInterface {
  name = 'trustedDevices1718700000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE "trusted_devices" ("uuid" varchar PRIMARY KEY NOT NULL, "user_uuid" varchar(36) NOT NULL, "hashed_token" varchar(255) NOT NULL, "label" varchar(255) NOT NULL, "created_at" bigint NOT NULL, "last_used_at" bigint, "expires_at" bigint NOT NULL)',
    )
    await queryRunner.query(
      'CREATE INDEX "index_trusted_devices_on_user_uuid" ON "trusted_devices" ("user_uuid")',
    )
    await queryRunner.query(
      'CREATE INDEX "index_trusted_devices_on_hashed_token" ON "trusted_devices" ("hashed_token")',
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "index_trusted_devices_on_hashed_token"')
    await queryRunner.query('DROP INDEX "index_trusted_devices_on_user_uuid"')
    await queryRunner.query('DROP TABLE "trusted_devices"')
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm'

export class appPasswords1718100000000 implements MigrationInterface {
  name = 'appPasswords1718100000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE "app_passwords" ("uuid" varchar PRIMARY KEY NOT NULL, "user_uuid" varchar(36) NOT NULL, "label" varchar(255) NOT NULL, "hashed_password" varchar(255) NOT NULL, "created_at" datetime NOT NULL, "last_used_at" datetime)',
    )
    await queryRunner.query('CREATE INDEX "index_app_passwords_on_user_uuid" ON "app_passwords" ("user_uuid")')
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "index_app_passwords_on_user_uuid"')
    await queryRunner.query('DROP TABLE "app_passwords"')
  }
}

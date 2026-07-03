import { MigrationInterface, QueryRunner } from 'typeorm'

export class appPasswordsExpiryAndRevocation1751200000000 implements MigrationInterface {
  name = 'appPasswordsExpiryAndRevocation1751200000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `app_passwords` ADD `expires_at` datetime NULL')
    await queryRunner.query('ALTER TABLE `app_passwords` ADD `revoked_at` datetime NULL')
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `app_passwords` DROP COLUMN `revoked_at`')
    await queryRunner.query('ALTER TABLE `app_passwords` DROP COLUMN `expires_at`')
  }
}

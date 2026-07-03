import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddRoleDescription1751000000000 implements MigrationInterface {
  name = 'AddRoleDescription1751000000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `roles` ADD `description` varchar(512) NULL DEFAULT NULL')
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `roles` DROP COLUMN `description`')
  }
}

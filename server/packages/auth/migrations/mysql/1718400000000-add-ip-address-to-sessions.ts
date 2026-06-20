import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddIpAddressToSessions1718400000000 implements MigrationInterface {
  name = 'AddIpAddressToSessions1718400000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `sessions` ADD `ip_address` varchar(45) NULL')
    await queryRunner.query('ALTER TABLE `revoked_sessions` ADD `ip_address` varchar(45) NULL')
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `revoked_sessions` DROP COLUMN `ip_address`')
    await queryRunner.query('ALTER TABLE `sessions` DROP COLUMN `ip_address`')
  }
}

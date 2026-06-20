import { MigrationInterface, QueryRunner } from 'typeorm'

export class shares1718300000000 implements MigrationInterface {
  name = 'shares1718300000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE `shares` (`uuid` varchar(36) NOT NULL, `user_uuid` varchar(36) NOT NULL, `type` varchar(20) NOT NULL, `encrypted_payload` text NOT NULL, `nickname` varchar(255) NULL, `created_at` bigint NOT NULL, `revoked` tinyint NOT NULL DEFAULT 0, INDEX `index_shares_on_user_uuid` (`user_uuid`), PRIMARY KEY (`uuid`)) ENGINE=InnoDB',
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX `index_shares_on_user_uuid` ON `shares`')
    await queryRunner.query('DROP TABLE `shares`')
  }
}

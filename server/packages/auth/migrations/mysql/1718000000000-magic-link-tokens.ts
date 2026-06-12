import { MigrationInterface, QueryRunner } from 'typeorm'

export class magicLinkTokens1718000000000 implements MigrationInterface {
  name = 'magicLinkTokens1718000000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE `magic_link_tokens` (`uuid` varchar(36) NOT NULL, `user_identifier` varchar(255) NOT NULL, `code` varchar(255) NOT NULL, `expires_at` datetime NOT NULL, `consumed` tinyint NOT NULL DEFAULT 0, `created_at` datetime NOT NULL, INDEX `index_magic_link_tokens_on_user_identifier` (`user_identifier`), PRIMARY KEY (`uuid`)) ENGINE=InnoDB',
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX `index_magic_link_tokens_on_user_identifier` ON `magic_link_tokens`',
    )
    await queryRunner.query('DROP TABLE `magic_link_tokens`')
  }
}

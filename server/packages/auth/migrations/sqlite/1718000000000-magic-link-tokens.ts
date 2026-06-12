import { MigrationInterface, QueryRunner } from 'typeorm'

export class magicLinkTokens1718000000000 implements MigrationInterface {
  name = 'magicLinkTokens1718000000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE "magic_link_tokens" ("uuid" varchar PRIMARY KEY NOT NULL, "user_identifier" varchar(255) NOT NULL, "code" varchar(255) NOT NULL, "expires_at" datetime NOT NULL, "consumed" boolean NOT NULL DEFAULT (0), "created_at" datetime NOT NULL)',
    )
    await queryRunner.query(
      'CREATE INDEX "index_magic_link_tokens_on_user_identifier" ON "magic_link_tokens" ("user_identifier")',
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "index_magic_link_tokens_on_user_identifier"')
    await queryRunner.query('DROP TABLE "magic_link_tokens"')
  }
}

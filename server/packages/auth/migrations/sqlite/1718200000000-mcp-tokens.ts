import { MigrationInterface, QueryRunner } from 'typeorm'

export class mcpTokens1718200000000 implements MigrationInterface {
  name = 'mcpTokens1718200000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE "mcp_tokens" ("uuid" varchar PRIMARY KEY NOT NULL, "user_uuid" varchar(36) NOT NULL, "label" varchar(255) NOT NULL, "hashed_token" varchar(255) NOT NULL, "scope" varchar(20) NOT NULL, "scope_tag_uuids" text, "wrapped_keys" text NOT NULL, "kdf_salt" varchar(255) NOT NULL, "kdf_params" text NOT NULL, "created_at" bigint NOT NULL, "last_used_at" bigint, "expires_at" bigint)',
    )
    await queryRunner.query('CREATE INDEX "index_mcp_tokens_on_user_uuid" ON "mcp_tokens" ("user_uuid")')
    await queryRunner.query('ALTER TABLE "sessions" ADD "mcp_scope_tag_uuids" text')
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "sessions" DROP COLUMN "mcp_scope_tag_uuids"')
    await queryRunner.query('DROP INDEX "index_mcp_tokens_on_user_uuid"')
    await queryRunner.query('DROP TABLE "mcp_tokens"')
  }
}

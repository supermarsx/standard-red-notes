import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Standard Red Notes: SIGNUP INVITE LINKS (SQLite). See the mysql counterpart for
 * the full rationale. All columns created up front (new table) so the later
 * self-serve + approval features need no ALTER.
 *
 * NOTE: identifiers are double-quoted (correct in SQLite with DQS off); the only
 * string literal is the created_by_kind default, single-quoted. UNIQUE timestamp
 * 1752400000000.
 */
export class signupInviteLinks1752400000000 implements MigrationInterface {
  name = 'signupInviteLinks1752400000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE "signup_invite_links" (' +
        '"uuid" varchar PRIMARY KEY NOT NULL, ' +
        '"hashed_token" varchar(255) NOT NULL, ' +
        '"label" varchar(255), ' +
        '"max_uses" integer NOT NULL DEFAULT (1), ' +
        '"used_count" integer NOT NULL DEFAULT (0), ' +
        '"expires_at" datetime, ' +
        '"revoked" boolean NOT NULL DEFAULT (0), ' +
        '"default_role" varchar(255), ' +
        '"allowed_domain" varchar(255), ' +
        '"created_by" varchar(255), ' +
        '"created_by_user_uuid" varchar(255), ' +
        "\"created_by_kind\" varchar(255) NOT NULL DEFAULT ('admin'), " +
        '"auto_approve" boolean NOT NULL DEFAULT (1), ' +
        '"created_at" datetime NOT NULL, ' +
        '"updated_at" datetime NOT NULL)',
    )
    await queryRunner.query(
      'CREATE INDEX "index_signup_invite_links_on_hashed_token" ON "signup_invite_links" ("hashed_token")',
    )
    await queryRunner.query(
      'CREATE INDEX "index_signup_invite_links_on_created_by_user_uuid" ON "signup_invite_links" ("created_by_user_uuid")',
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "index_signup_invite_links_on_created_by_user_uuid"')
    await queryRunner.query('DROP INDEX "index_signup_invite_links_on_hashed_token"')
    await queryRunner.query('DROP TABLE "signup_invite_links"')
  }
}

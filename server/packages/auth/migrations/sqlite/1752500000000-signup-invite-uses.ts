import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Standard Red Notes: SIGNUP INVITE USES (SQLite). See the mysql counterpart —
 * an append-only attribution / usage-audit row per consumed invite slot.
 *
 * NOTE: identifiers are double-quoted (correct in SQLite with DQS off); there are
 * NO string literals. UNIQUE timestamp 1752500000000.
 */
export class signupInviteUses1752500000000 implements MigrationInterface {
  name = 'signupInviteUses1752500000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE "signup_invite_uses" (' +
        '"uuid" varchar PRIMARY KEY NOT NULL, ' +
        '"invite_link_uuid" varchar(255) NOT NULL, ' +
        '"new_user_uuid" varchar(255) NOT NULL, ' +
        '"referrer_user_uuid" varchar(255), ' +
        '"created_at" datetime NOT NULL)',
    )
    await queryRunner.query(
      'CREATE INDEX "index_signup_invite_uses_on_invite_link_uuid" ON "signup_invite_uses" ("invite_link_uuid")',
    )
    await queryRunner.query(
      'CREATE INDEX "index_signup_invite_uses_on_referrer_user_uuid" ON "signup_invite_uses" ("referrer_user_uuid")',
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "index_signup_invite_uses_on_referrer_user_uuid"')
    await queryRunner.query('DROP INDEX "index_signup_invite_uses_on_invite_link_uuid"')
    await queryRunner.query('DROP TABLE "signup_invite_uses"')
  }
}

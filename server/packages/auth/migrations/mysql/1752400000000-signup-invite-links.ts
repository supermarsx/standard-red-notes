import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Standard Red Notes: SIGNUP INVITE LINKS — durable, admin/user-minted invite
 * links with an atomic per-link account cap ("X accounts"). Modeled on the
 * email-confirmation token table (only the SHA-256 hash of the raw token is
 * stored). All columns are created up front (the table is new): the per-link
 * role/domain overrides, the self-serve attribution columns
 * (created_by_user_uuid / created_by_kind) and auto_approve all live here so the
 * later self-serve + approval features need no ALTER.
 *
 * UNIQUE timestamp 1752400000000 (dup timestamps broke ordering in t38-e1).
 */
export class signupInviteLinks1752400000000 implements MigrationInterface {
  name = 'signupInviteLinks1752400000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE `signup_invite_links` (' +
        '`uuid` varchar(36) NOT NULL, ' +
        '`hashed_token` varchar(255) NOT NULL, ' +
        '`label` varchar(255) NULL, ' +
        '`max_uses` int NOT NULL DEFAULT 1, ' +
        '`used_count` int NOT NULL DEFAULT 0, ' +
        '`expires_at` datetime NULL, ' +
        '`revoked` tinyint NOT NULL DEFAULT 0, ' +
        '`default_role` varchar(255) NULL, ' +
        '`allowed_domain` varchar(255) NULL, ' +
        '`created_by` varchar(255) NULL, ' +
        '`created_by_user_uuid` varchar(255) NULL, ' +
        "`created_by_kind` varchar(255) NOT NULL DEFAULT 'admin', " +
        '`auto_approve` tinyint NOT NULL DEFAULT 1, ' +
        '`created_at` datetime NOT NULL, ' +
        '`updated_at` datetime NOT NULL, ' +
        'INDEX `index_signup_invite_links_on_hashed_token` (`hashed_token`), ' +
        'INDEX `index_signup_invite_links_on_created_by_user_uuid` (`created_by_user_uuid`), ' +
        'PRIMARY KEY (`uuid`)) ENGINE=InnoDB',
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX `index_signup_invite_links_on_created_by_user_uuid` ON `signup_invite_links`',
    )
    await queryRunner.query('DROP INDEX `index_signup_invite_links_on_hashed_token` ON `signup_invite_links`')
    await queryRunner.query('DROP TABLE `signup_invite_links`')
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Standard Red Notes: SIGNUP INVITE USES — an append-only attribution / usage-audit
 * row written once per consumed invite slot (see ConsumeSignupInvite). Powers
 * "who signed up via link L" and referral attribution ("who X invited", via
 * referrer_user_uuid) without scanning the audit log.
 *
 * UNIQUE timestamp 1752500000000.
 */
export class signupInviteUses1752500000000 implements MigrationInterface {
  name = 'signupInviteUses1752500000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE `signup_invite_uses` (' +
        '`uuid` varchar(36) NOT NULL, ' +
        '`invite_link_uuid` varchar(255) NOT NULL, ' +
        '`new_user_uuid` varchar(255) NOT NULL, ' +
        '`referrer_user_uuid` varchar(255) NULL, ' +
        '`created_at` datetime NOT NULL, ' +
        'INDEX `index_signup_invite_uses_on_invite_link_uuid` (`invite_link_uuid`), ' +
        'INDEX `index_signup_invite_uses_on_referrer_user_uuid` (`referrer_user_uuid`), ' +
        'PRIMARY KEY (`uuid`)) ENGINE=InnoDB',
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX `index_signup_invite_uses_on_referrer_user_uuid` ON `signup_invite_uses`')
    await queryRunner.query('DROP INDEX `index_signup_invite_uses_on_invite_link_uuid` ON `signup_invite_uses`')
    await queryRunner.query('DROP TABLE `signup_invite_uses`')
  }
}

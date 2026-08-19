import { MigrationInterface, QueryRunner } from 'typeorm'

export class inviteEventOutbox1787097600000 implements MigrationInterface {
  name = 'inviteEventOutbox1787097600000'

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE `invite_event_outbox` (`uuid` varchar(36) NOT NULL, `event_json` text NOT NULL, `affected_user_uuids_json` text NOT NULL, `fanout_hash` varchar(64) NOT NULL, `status` varchar(16) NOT NULL, `attempts` int NOT NULL DEFAULT 0, `available_at_timestamp` bigint NOT NULL, `locked_at_timestamp` bigint NULL, `lock_token` varchar(36) NULL, `last_attempt_at_timestamp` bigint NULL, `last_error_code` varchar(64) NULL, `created_at_timestamp` bigint NOT NULL, `updated_at_timestamp` bigint NOT NULL, `published_at_timestamp` bigint NULL, INDEX `index_invite_event_outbox_dispatch` (`status`, `available_at_timestamp`), INDEX `index_invite_event_outbox_stale_lease` (`status`, `locked_at_timestamp`), INDEX `index_invite_event_outbox_published_at` (`published_at_timestamp`), INDEX `index_invite_event_outbox_fanout_hash` (`fanout_hash`), PRIMARY KEY (`uuid`)) ENGINE=InnoDB',
    )
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `invite_event_outbox`')
  }
}

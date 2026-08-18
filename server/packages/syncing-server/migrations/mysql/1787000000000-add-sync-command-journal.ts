import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddSyncCommandJournal1787000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE sync_commands (
        uuid varchar(36) NOT NULL,
        user_uuid varchar(36) NOT NULL,
        session_uuid varchar(36) NOT NULL,
        command_id varchar(128) NOT NULL,
        request_digest varchar(64) NOT NULL,
        status varchar(16) NOT NULL,
        response_json longtext NULL,
        execution_token varchar(36) NULL,
        created_at_timestamp bigint NOT NULL,
        updated_at_timestamp bigint NOT NULL,
        expires_at_timestamp bigint NOT NULL,
        PRIMARY KEY (uuid),
        UNIQUE KEY index_sync_commands_scope_command (user_uuid, session_uuid, command_id),
        KEY index_sync_commands_expires_at (expires_at_timestamp)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
    `)

    await queryRunner.query(`
      CREATE TABLE sync_command_outbox (
        uuid varchar(36) NOT NULL,
        event_json longtext NOT NULL,
        status varchar(16) NOT NULL,
        attempts int NOT NULL DEFAULT 0,
        available_at_timestamp bigint NOT NULL,
        locked_at_timestamp bigint NULL,
        lock_token varchar(36) NULL,
        created_at_timestamp bigint NOT NULL,
        updated_at_timestamp bigint NOT NULL,
        published_at_timestamp bigint NULL,
        PRIMARY KEY (uuid),
        KEY index_sync_command_outbox_dispatch (status, available_at_timestamp),
        KEY index_sync_command_outbox_published_at (published_at_timestamp)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS sync_command_outbox')
    await queryRunner.query('DROP TABLE IF EXISTS sync_commands')
  }
}

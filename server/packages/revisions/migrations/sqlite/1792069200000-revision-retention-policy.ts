import { MigrationInterface, QueryRunner } from 'typeorm'

export class RevisionRetentionPolicy1792069200000 implements MigrationInterface {
  name = 'RevisionRetentionPolicy1792069200000'
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE revisions_revisions ADD COLUMN source_updated_at bigint NULL')
    await queryRunner.query('ALTER TABLE revisions_revisions ADD COLUMN coalesced_changes integer NOT NULL DEFAULT 1')
    await queryRunner.query('CREATE TABLE revisions_policy_lock (id integer NOT NULL PRIMARY KEY)')
    await queryRunner.query('INSERT INTO revisions_policy_lock (id) VALUES (1)')
    await queryRunner.query('CREATE INDEX revision_retention_item ON revisions_revisions (item_uuid, created_at, uuid)')
    await queryRunner.query('CREATE INDEX revision_retention_user ON revisions_revisions (user_uuid, created_at, uuid)')
    await queryRunner.query('CREATE INDEX revision_retention_age ON revisions_revisions (created_at, uuid)')
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX revision_retention_item')
    await queryRunner.query('DROP INDEX revision_retention_user')
    await queryRunner.query('DROP INDEX revision_retention_age')
    await queryRunner.query('DROP TABLE revisions_policy_lock')
    await queryRunner.query('ALTER TABLE revisions_revisions DROP COLUMN source_updated_at')
    await queryRunner.query('ALTER TABLE revisions_revisions DROP COLUMN coalesced_changes')
  }
}

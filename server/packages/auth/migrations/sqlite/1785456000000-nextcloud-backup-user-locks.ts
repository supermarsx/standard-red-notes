import { MigrationInterface, QueryRunner } from 'typeorm'

export class NextcloudBackupUserLocks1785456000000 implements MigrationInterface {
  name = 'NextcloudBackupUserLocks1785456000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE "nextcloud_backup_user_locks" ("user_uuid" varchar(36) PRIMARY KEY NOT NULL, "updated_at" bigint NOT NULL, CONSTRAINT "FK_nextcloud_backup_user_locks_user_uuid" FOREIGN KEY ("user_uuid") REFERENCES "users" ("uuid") ON DELETE CASCADE)',
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "nextcloud_backup_user_locks"')
  }
}

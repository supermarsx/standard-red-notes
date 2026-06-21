import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Standard Red Notes — OPTIONAL, NOT AUTO-RUN (sqlite variant).
 *
 * Mirrors migrations-optional/mysql/1750000000000-enable-nextcloud-backups.ts. It
 * lives outside the `migrations/` glob the auth DataSource discovers, so it is never
 * executed automatically. Scheduled Nextcloud backups are DEFAULT OFF and require no
 * seeded permission or setting rows (per-user settings are created on demand when the
 * user saves them from Preferences -> Backups). This migration performs NO writes.
 */
export class EnableNextcloudBackups1750000000000 implements MigrationInterface {
  public async up(_queryRunner: QueryRunner): Promise<void> {
    // Intentionally a no-op. See the docblock and the mysql variant.
    return
  }

  public async down(): Promise<void> {
    return
  }
}

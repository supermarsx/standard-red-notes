import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Standard Red Notes — OPTIONAL, NOT AUTO-RUN.
 *
 * This file lives in `migrations-optional/` (NOT the `migrations/` glob that the
 * auth DataSource discovers), so it is provided for reference but never executed
 * automatically. Scheduled Nextcloud backups are DEFAULT OFF.
 *
 * Unlike email backups, Nextcloud backups are NOT gated by a role permission: the
 * feature is enabled instance-wide by the NEXTCLOUD_BACKUPS_ENABLED env flag and,
 * per user, by completeness of their NEXTCLOUD_BACKUP_URL + NEXTCLOUD_BACKUP_APP_PASSWORD
 * + a recurring NEXTCLOUD_BACKUP_FREQUENCY. Those per-user setting rows are created
 * on demand when the user saves them from Preferences -> Backups; no rows need to be
 * seeded.
 *
 * Therefore this migration intentionally performs NO writes. It exists so an operator
 * who later chooses to gate Nextcloud backups behind a dedicated permission has a
 * documented, copy-pasteable starting point (mirroring the email-backup permission
 * migrations) without changing default behaviour.
 */
export class EnableNextcloudBackups1750000000000 implements MigrationInterface {
  public async up(_queryRunner: QueryRunner): Promise<void> {
    // Intentionally a no-op. See the class docblock: Nextcloud backups are
    // env-gated + per-user-completeness-gated and require no seeded permission or
    // setting rows. To permission-gate the feature instead, insert role_permissions
    // rows here mirroring migrations/mysql/1705493201352-enable-email-backups-for-all.ts.
    return
  }

  public async down(): Promise<void> {
    return
  }
}

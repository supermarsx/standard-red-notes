/**
 * These names are owned by the Standard Red Notes server. The web app's
 * published @standardnotes/domain-core dependency does not yet include them,
 * so they intentionally use the settings service's raw-name API.
 */
export const NextcloudBackupSettingName = {
  Frequency: 'NEXTCLOUD_BACKUP_FREQUENCY',
  Url: 'NEXTCLOUD_BACKUP_URL',
  Folder: 'NEXTCLOUD_BACKUP_FOLDER',
  AppPassword: 'NEXTCLOUD_BACKUP_APP_PASSWORD',
} as const

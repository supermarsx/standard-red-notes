import { KeyParamsData } from '@standardnotes/responses'

import { Item } from './Item'

export interface WebDAVBackupDestination {
  url: string
  username: string
  appPassword: string
  folder: string
}

/**
 * Standard Red Notes: backup service that uploads the user's ALREADY end-to-end
 * encrypted items to a Nextcloud instance over WebDAV. Mirrors the data shape that
 * S3ItemBackupService writes (items + auth_params), but the destination is per-user
 * (resolved auth-side and carried in the NEXTCLOUD_BACKUP_REQUESTED event) rather
 * than a single instance-wide bucket.
 */
export interface WebDAVItemBackupServiceInterface {
  /**
   * Serialize the items into the encrypted backup JSON artifact and upload it to
   * <url>/remote.php/dav/files/<username>/<folder>/SN-Data-<date>.json.
   * Returns the uploaded file name on success, or null on failure (errors are
   * logged and swallowed so the batch job is never crashed).
   */
  uploadBackup(items: Item[], authParams: KeyParamsData, destination: WebDAVBackupDestination): Promise<string | null>
}

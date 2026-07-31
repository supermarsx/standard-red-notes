export interface NextcloudBackupRequestedEventPayload {
  userUuid: string
  /**
   * Added after the first Nextcloud-backup event version. New publishers must
   * always provide it; consumers keep this optional on the wire so a syncing
   * service can safely drain events emitted by an older auth service during a
   * rolling upgrade.
   */
  requestUuid?: string
  keyParams: Record<string, unknown>
  // Standard Red Notes: the destination + credential are resolved auth-side (where
  // the per-user settings live, including decrypting the sensitive app password) and
  // carried in the event so the syncing-server handler — which owns item access but
  // not the settings DB — can perform the WebDAV upload. The app password is a
  // server-internal value here; it never leaves the server boundary in plaintext to
  // any client. Nextcloud only ever receives the already-encrypted backup artifact.
  nextcloudUrl: string
  nextcloudFolder: string
  nextcloudAppPassword: string
}

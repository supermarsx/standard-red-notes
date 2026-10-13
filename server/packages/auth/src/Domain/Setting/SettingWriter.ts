import { SettingName } from '@standardnotes/domain-core'

/**
 * Standard Red Notes: WHO MAY WRITE a setting, declared once, for every setting.
 *
 *   - `owner`                   the account's own choice. Only its owner writes it.
 *   - `owner-or-administrator`  still the owner's own choice, which an
 *                               administrator may also see and set for them.
 *   - `administrator`           a GATE: what the account is allowed, or how much.
 *                               Only an administrator writes it; its owner can
 *                               neither set it nor delete it.
 *   - `server`                  bookkeeping the server keeps for itself.
 *
 * *** WHY THIS IS A TOTAL TABLE AND NOT A LIST OF EXCEPTIONS. *** It used to be a
 * list, `CLIENT_IMMUTABLE_SETTINGS`: a setting was writable by its owner unless
 * somebody remembered to add it there. Three administrator gates were added to
 * every other list they needed (the admin panel's, the unencrypted one, the
 * token's) and not to that one, and nothing went red, because forgetting a deny
 * list means "allowed". Measured on both topologies, as an ordinary signed-in
 * user, against their own account:
 *
 *   PUT /v1/users/<own uuid>/settings {"name":"WORKFLOWS_ENABLED","value":"true"}        200
 *   PUT /v1/users/<own uuid>/settings {"name":"OCR_SERVER_ALLOWED","value":"true"}       200
 *   PUT /v1/users/<own uuid>/settings {"name":"NEXTCLOUD_BACKUP_ALLOWED","value":"true"} 200
 *
 * and the same account could overwrite or DELETE a value an administrator had
 * set. Each of those is documented, where it is declared, as something an
 * administrator grants.
 *
 * So the question is now asked the other way round and cannot be skipped. The
 * table below is keyed by `SettingName.NAMES`, and its type requires an entry for
 * every key: a setting added there without a line here does not compile. And
 * `isWritableByItsOwner` answers `false` for anything it does not know, so even a
 * name that reached the database some other way is refused to a client.
 *
 * Choosing a class is still a decision somebody types. What catches the wrong
 * one is `SettingWriter.spec.ts`, which holds this table against the two places
 * a gate actually takes effect: the admin panel's own allow-list, and the
 * settings minted into the cross-service token.
 */
export type SettingWriter = 'owner' | 'owner-or-administrator' | 'administrator' | 'server'

const WRITER_BY_SETTING: Record<keyof typeof SettingName.NAMES, SettingWriter> = {
  // --- The account's own. ---------------------------------------------------
  // Writing MFA_SECRET additionally needs a valid current TOTP token, and
  // deleting it the server password; both are enforced where it is written.
  MfaSecret: 'owner',
  MagicLinkEnabled: 'owner',
  ExtensionKey: 'owner',
  DropboxBackupFrequency: 'owner',
  DropboxBackupToken: 'owner',
  OneDriveBackupFrequency: 'owner',
  OneDriveBackupToken: 'owner',
  GoogleDriveBackupFrequency: 'owner',
  GoogleDriveBackupToken: 'owner',
  MuteSignInEmails: 'owner',
  MuteMarketingEmails: 'owner',
  LogSessionUserAgent: 'owner',
  RecoveryCodes: 'owner',
  // Client-side defaults the web client reads back for itself.
  ConflictResolutionStrategy: 'owner',
  SearchIndexEnabled: 'owner',
  // Client-side ciphertext only; deleting it removes the escrow.
  AccountRecoveryEscrow: 'owner',
  // Where this account's scheduled backup goes. Whether it may go anywhere at
  // all is NEXTCLOUD_BACKUP_ALLOWED, below, and that is not the owner's.
  NextcloudBackupUrl: 'owner',
  NextcloudBackupFolder: 'owner',
  NextcloudBackupAppPassword: 'owner',
  // Opt-ins that publish only what the owner then chooses to publish, to a feed
  // or channel of their own. Declared as the owner's where they are named.
  CaldavEnabled: 'owner',
  ReminderDeliveryEnabled: 'owner',

  // --- The owner's own, which an administrator may also set. -----------------
  EmailBackupFrequency: 'owner-or-administrator',
  EmailRemindersEnabled: 'owner-or-administrator',
  NextcloudBackupFrequency: 'owner-or-administrator',

  // --- Gates. Only an administrator. -----------------------------------------
  // Unset means ENABLED for these three, so an owner who could write or delete
  // them could restore access after an administrator had taken it away.
  AiEnabled: 'administrator',
  CollaborationEnabled: 'administrator',
  LiveSyncEnabled: 'administrator',
  // How much of a metered thing the account may use.
  AiRequestLimit: 'administrator',
  AiFiveHourTokenLimit: 'administrator',
  AiWeeklyTokenLimit: 'administrator',
  FileUploadBytesLimit: 'administrator',
  // Off unless granted. Each of these makes the SERVER do something for the
  // account that the administrator has to have agreed to:
  //   - the DAV bridge and scheduled Nextcloud backups make it open connections
  //     to an address the user typed, carrying a stored password;
  //   - server OCR makes it run recognition on images the user uploads;
  //   - workflows hands out the operator's workflow engine.
  DavBridgeAllowed: 'administrator',
  NextcloudBackupAllowed: 'administrator',
  OcrServerAllowed: 'administrator',
  WorkflowsEnabled: 'administrator',
  // Instance-wide. An ordinary user who could write it on their own record could
  // close signups for everybody. Register additionally counts only rows owned by
  // an administrator, so a row written before this existed is ignored.
  RegistrationDisabled: 'administrator',

  // --- The server's own bookkeeping. -----------------------------------------
  ListedAuthorSecrets: 'server',
  FileUploadBytesUsed: 'server',
  EmailBackupLastSent: 'server',
  EmailBackupDeliveryState: 'server',
  NextcloudBackupLastRun: 'server',
  NextcloudBackupDeliveryState: 'server',
}

const WRITER_BY_NAME = new Map<string, SettingWriter>(
  (Object.keys(WRITER_BY_SETTING) as Array<keyof typeof SettingName.NAMES>).map((key) => [
    SettingName.NAMES[key],
    WRITER_BY_SETTING[key],
  ]),
)

/** Who may write the setting with this wire name; `undefined` for a name nobody declared. */
export const writerOfSetting = (settingName: string): SettingWriter | undefined => WRITER_BY_NAME.get(settingName)

/** Every declared setting name written by one of the given classes. */
export const settingsWrittenBy = (...writers: SettingWriter[]): string[] =>
  [...WRITER_BY_NAME].filter(([, writer]) => writers.includes(writer)).map(([name]) => name)

/**
 * May the account that owns a setting write or delete it through its own
 * settings endpoint? Only when it was declared as the owner's. A name nobody
 * declared is refused.
 */
export const isWritableByItsOwner = (settingName: string): boolean => {
  const writer = WRITER_BY_NAME.get(settingName)

  return writer === 'owner' || writer === 'owner-or-administrator'
}

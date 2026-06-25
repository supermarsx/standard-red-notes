import { Result } from '../Core/Result'
import { ValueObject } from '../Core/ValueObject'

import { SettingNameProps } from './SettingNameProps'

export class SettingName extends ValueObject<SettingNameProps> {
  static readonly NAMES = {
    MfaSecret: 'MFA_SECRET',
    MagicLinkEnabled: 'MAGIC_LINK_ENABLED',
    ExtensionKey: 'EXTENSION_KEY',
    EmailBackupFrequency: 'EMAIL_BACKUP_FREQUENCY',
    DropboxBackupFrequency: 'DROPBOX_BACKUP_FREQUENCY',
    DropboxBackupToken: 'DROPBOX_BACKUP_TOKEN',
    OneDriveBackupFrequency: 'ONE_DRIVE_BACKUP_FREQUENCY',
    OneDriveBackupToken: 'ONE_DRIVE_BACKUP_TOKEN',
    GoogleDriveBackupFrequency: 'GOOGLE_DRIVE_BACKUP_FREQUENCY',
    GoogleDriveBackupToken: 'GOOGLE_DRIVE_BACKUP_TOKEN',
    MuteSignInEmails: 'MUTE_SIGN_IN_EMAILS',
    MuteMarketingEmails: 'MUTE_MARKETING_EMAILS',
    ListedAuthorSecrets: 'LISTED_AUTHOR_SECRETS',
    LogSessionUserAgent: 'LOG_SESSION_USER_AGENT',
    RecoveryCodes: 'RECOVERY_CODES',
    FileUploadBytesLimit: 'FILE_UPLOAD_BYTES_LIMIT',
    FileUploadBytesUsed: 'FILE_UPLOAD_BYTES_USED',
    // Standard Red Notes: admin-managed per-user feature flags.
    AiEnabled: 'AI_ENABLED',
    AiRequestLimit: 'AI_REQUEST_LIMIT',
    // Standard Red Notes: admin-managed instance flag for whether new signups
    // are allowed. Persisted as a setting so the admin panel state survives; see
    // the TODO in Register.ts about having registration consult this at runtime.
    RegistrationDisabled: 'REGISTRATION_DISABLED',
    // Standard Red Notes: per-user gating for collaboration (shared vaults) and
    // live-sync websocket push. Default ENABLED when unset; value 'false'
    // disables the feature (opt-in disable).
    CollaborationEnabled: 'COLLABORATION_ENABLED',
    LiveSyncEnabled: 'LIVE_SYNC_ENABLED',
    // Standard Red Notes: server-provided DEFAULT strategy for resolving sync
    // conflicts (conflicted copies). Valid values mirror the client pref:
    // 'ask' | 'keepBoth' | 'keepLocal' | 'keepRemote'. The client reads this via
    // the standard getSetting endpoint and uses it only as a fallback default;
    // the per-user client preference always takes precedence when set.
    ConflictResolutionStrategy: 'CONFLICT_RESOLUTION_STRATEGY',
    // Standard Red Notes: server-provided DEFAULT for whether the client-side
    // full-text search index is enabled. The client reads this via the standard
    // getSetting endpoint and uses it only as a fallback default; the per-user
    // client preference (SearchIndexEnabled) always takes precedence when set.
    // Value is the string 'true' or 'false'.
    SearchIndexEnabled: 'SEARCH_INDEX_ENABLED',
    // Standard Red Notes: OPTIONAL, OFF-BY-DEFAULT account/password recovery
    // escrow. Holds a CLIENT-SIDE ciphertext blob (the account master key
    // encrypted under a key derived from a high-entropy recovery code that is
    // shown to the user ONCE and never sent to the server). The server stores
    // only this opaque ciphertext; it CANNOT decrypt it without the user-held
    // recovery code. This setting exists only for accounts that explicitly
    // opted in; deleting it removes the escrow. See the Security preferences
    // "Account recovery" opt-in for the full warning and tradeoff.
    AccountRecoveryEscrow: 'ACCOUNT_RECOVERY_ESCROW',
    // Standard Red Notes: server-managed bookkeeping for scheduled email backups.
    // Records the last time an email backup was triggered for the user, as a
    // millisecond epoch string. Used by the due-calculation so a single cron can
    // serve daily/weekly/monthly cadences and catch up missed runs. Server-written
    // only (CLIENT-IMMUTABLE); unencrypted/unsensitive so the trigger job can read
    // it without per-user key material.
    EmailBackupLastSent: 'EMAIL_BACKUP_LAST_SENT',
    // Standard Red Notes: per-user, OFF-BY-DEFAULT scheduled encrypted-backup
    // upload to a Nextcloud instance over WebDAV. This is NOT a sync replacement:
    // it uploads the user's ALREADY end-to-end-encrypted backup artifact (the same
    // ciphertext the server already holds) to a Nextcloud folder on a cadence. The
    // server never has plaintext; Nextcloud only ever receives ciphertext.
    //
    // Frequency selects the cadence (disabled|daily|weekly|monthly). URL + folder
    // address the destination. App-password authenticates the WebDAV PUT and is the
    // ONLY sensitive value here (encrypted at rest + never returned by getSetting);
    // url/folder/frequency are unencrypted/unsensitive so the trigger job can read
    // them without per-user key material and the client can display them back.
    NextcloudBackupFrequency: 'NEXTCLOUD_BACKUP_FREQUENCY',
    NextcloudBackupUrl: 'NEXTCLOUD_BACKUP_URL',
    NextcloudBackupFolder: 'NEXTCLOUD_BACKUP_FOLDER',
    // SENSITIVE: a dedicated low-privilege Nextcloud app password. Encrypted at rest
    // and excluded from the unsensitive list so a normal getSetting read returns no
    // value; only the server-side trigger job decrypts it to perform the upload.
    NextcloudBackupAppPassword: 'NEXTCLOUD_BACKUP_APP_PASSWORD',
    // Server-written bookkeeping (CLIENT-IMMUTABLE) mirroring EmailBackupLastSent:
    // ms-epoch string of the last Nextcloud backup run, used by the due-calculator
    // so one cron can serve daily/weekly/monthly and catch up missed runs.
    NextcloudBackupLastRun: 'NEXTCLOUD_BACKUP_LAST_RUN',
    // Standard Red Notes: per-user, OFF-BY-DEFAULT admin gate for scheduled
    // Nextcloud backups. Mirrors OcrServerAllowed: a plain 'true'/'false' flag the
    // admin panel toggles per user. The scheduled trigger requires this flag to be
    // 'true' (composed with the operator master switch NEXTCLOUD_BACKUPS_ENABLED and
    // per-user completeness) before it will upload, so an operator must opt a user
    // in. Carries no secret; unencrypted/unsensitive so the trigger job can read it
    // without per-user key material. Default disabled (absent/anything-but-'true').
    NextcloudBackupAllowed: 'NEXTCLOUD_BACKUP_ALLOWED',
    // Standard Red Notes: per-user opt-in for EMAIL REMINDERS. When 'true', the
    // scheduled email-reminder cron is allowed to email this user the reminders
    // they have EXPLICITLY registered for emailing (see the email_reminders table).
    // Default disabled (absent/anything-but-'true'). Client-MUTABLE so the user can
    // opt in/out; unencrypted/unsensitive so the trigger job can read it without
    // per-user key material. Admin-manageable so an operator can view/override it.
    // NOTE: enabling this setting alone emails nothing — the user must also opt
    // INDIVIDUAL reminders into emailing, which sends those reminders' time + text
    // to the server in PLAINTEXT (they leave end-to-end encryption for that purpose).
    EmailRemindersEnabled: 'EMAIL_REMINDERS_ENABLED',
    // Standard Red Notes: per-user, OFF-BY-DEFAULT opt-in for SERVER-SIDE PDF OCR.
    // When 'true' (and the operator master switch OCR_SERVER_ENABLED is on), the
    // client is allowed to offer "Run OCR on server", which uploads the PDF's
    // DECRYPTED page image(s) to the api-gateway OCR endpoint for tesseract-in-Node
    // recognition. This LEAVES end-to-end encryption for that request (the server
    // sees the page content), exactly like the AI assistant proxy — hence opt-in
    // and admin-manageable. Default disabled (absent/anything-but-'true'); browser
    // OCR (which stays fully on-device/E2E) remains the default path regardless.
    // Client-MUTABLE not required: this is gated by an admin, so it is admin-set;
    // unencrypted/unsensitive so the gateway can read it without per-user key
    // material when deciding whether to honor a server-OCR request.
    OcrServerAllowed: 'OCR_SERVER_ALLOWED',
    // Standard Red Notes: per-user, OFF-BY-DEFAULT opt-in for the read-only CalDAV
    // calendar feed. When 'true' (and the operator master switch CALDAV_ENABLED is
    // on), the user's EXPLICITLY PUBLISHED reminders/todos (held in a separate,
    // server-readable "published calendar" store — NOT the E2E note content) are
    // served as an iCalendar VTODO feed to standard CalDAV clients authenticating
    // with a scoped, revocable CalDAV access token. Nothing is published until the
    // user opts in AND publishes specific items; the published copy leaves
    // end-to-end encryption by design (it is plaintext in the published store),
    // exactly like other opt-in server features. Default disabled
    // (absent/anything-but-'true'). Client-MUTABLE so the user controls it;
    // unencrypted/unsensitive so the gateway can read it without per-user key
    // material when deciding whether to serve the feed.
    CaldavEnabled: 'CALDAV_ENABLED',
  }

  get value(): string {
    return this.props.value
  }

  isSensitive(): boolean {
    return [
      SettingName.NAMES.MfaSecret,
      SettingName.NAMES.ExtensionKey,
      // Standard Red Notes: the Nextcloud app password grants WebDAV file access to
      // the user's Nextcloud account, so it is treated as sensitive (encrypted at
      // rest, never returned by a normal getSetting read).
      SettingName.NAMES.NextcloudBackupAppPassword,
    ].includes(this.props.value)
  }

  isASubscriptionSetting(): boolean {
    return [
      SettingName.NAMES.FileUploadBytesLimit,
      SettingName.NAMES.FileUploadBytesUsed,
      SettingName.NAMES.MuteSignInEmails,
    ].includes(this.props.value)
  }

  isARegularOnlySubscriptionSetting(): boolean {
    return [SettingName.NAMES.FileUploadBytesLimit, SettingName.NAMES.FileUploadBytesUsed].includes(this.props.value)
  }

  isASharedAndRegularOnlySubscriptionSetting(): boolean {
    return [SettingName.NAMES.MuteSignInEmails].includes(this.props.value)
  }

  private constructor(props: SettingNameProps) {
    super(props)
  }

  static create(name: string): Result<SettingName> {
    const isValidName = Object.values(this.NAMES).includes(name)
    if (!isValidName) {
      return Result.fail<SettingName>(`Invalid setting name: ${name}`)
    } else {
      return Result.ok<SettingName>(new SettingName({ value: name }))
    }
  }
}

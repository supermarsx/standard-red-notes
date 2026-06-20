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
  }

  get value(): string {
    return this.props.value
  }

  isSensitive(): boolean {
    return [SettingName.NAMES.MfaSecret, SettingName.NAMES.ExtensionKey].includes(this.props.value)
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

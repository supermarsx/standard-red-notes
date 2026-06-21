import { PermissionName } from '@standardnotes/features'
import { SettingName } from '@standardnotes/domain-core'
import { LogSessionUserAgentOption, MuteMarketingEmailsOption } from '@standardnotes/settings'
import { injectable } from 'inversify'

import { EncryptionVersion } from '../Encryption/EncryptionVersion'
import { SettingDescription } from './SettingDescription'

import { SettingsAssociationServiceInterface } from './SettingsAssociationServiceInterface'

@injectable()
export class SettingsAssociationService implements SettingsAssociationServiceInterface {
  private readonly UNENCRYPTED_SETTINGS = [
    SettingName.NAMES.EmailBackupFrequency,
    SettingName.NAMES.EmailBackupLastSent,
    SettingName.NAMES.EmailRemindersEnabled,
    // Standard Red Notes: Nextcloud scheduled-backup config. Frequency, URL, folder
    // and last-run bookkeeping carry no secret and must be readable by the trigger
    // job without per-user key material, so they are stored unencrypted. The app
    // PASSWORD is deliberately ABSENT here -> it is encrypted at rest (default).
    SettingName.NAMES.NextcloudBackupFrequency,
    SettingName.NAMES.NextcloudBackupUrl,
    SettingName.NAMES.NextcloudBackupFolder,
    SettingName.NAMES.NextcloudBackupLastRun,
    SettingName.NAMES.MuteSignInEmails,
    SettingName.NAMES.MuteMarketingEmails,
    SettingName.NAMES.DropboxBackupFrequency,
    SettingName.NAMES.GoogleDriveBackupFrequency,
    SettingName.NAMES.OneDriveBackupFrequency,
    SettingName.NAMES.LogSessionUserAgent,
  ]

  private readonly UNSENSITIVE_SETTINGS = [
    SettingName.NAMES.DropboxBackupFrequency,
    SettingName.NAMES.GoogleDriveBackupFrequency,
    SettingName.NAMES.OneDriveBackupFrequency,
    SettingName.NAMES.EmailBackupFrequency,
    SettingName.NAMES.EmailBackupLastSent,
    SettingName.NAMES.EmailRemindersEnabled,
    SettingName.NAMES.MuteSignInEmails,
    SettingName.NAMES.MuteMarketingEmails,
    // Standard Red Notes: Nextcloud scheduled-backup config that the owning client
    // must be able to read back to render the preferences pane. These carry no
    // secret. The app PASSWORD is intentionally NOT listed here, so it stays
    // sensitive (getSetting returns no value) — see SettingName.isSensitive().
    SettingName.NAMES.NextcloudBackupFrequency,
    SettingName.NAMES.NextcloudBackupUrl,
    SettingName.NAMES.NextcloudBackupFolder,
    SettingName.NAMES.NextcloudBackupLastRun,
    SettingName.NAMES.ListedAuthorSecrets,
    SettingName.NAMES.LogSessionUserAgent,
    SettingName.NAMES.RecoveryCodes,
    // Standard Red Notes: the account-recovery escrow holds only client-side
    // ciphertext (see SettingName.AccountRecoveryEscrow). It must be retrievable
    // by the owning client so it can run the recovery flow, so it is not marked
    // "sensitive" (which would block normal getSetting reads). Confidentiality
    // comes from the client-side encryption, not from server-side gating.
    SettingName.NAMES.AccountRecoveryEscrow,
    // Standard Red Notes: admin-provided client DEFAULTS that the web client
    // reads back via the standard getSetting endpoint (the Conflicts and
    // Assistant/Search panes). They carry no secret — just a plain default value
    // ('ask'|'keepBoth'|... and 'true'|'false') — so they must be retrievable as
    // a normal value rather than gated as "sensitive" (which returns no value).
    SettingName.NAMES.ConflictResolutionStrategy,
    SettingName.NAMES.SearchIndexEnabled,
  ]

  private readonly CLIENT_IMMUTABLE_SETTINGS = [
    SettingName.NAMES.ListedAuthorSecrets,
    SettingName.NAMES.FileUploadBytesLimit,
    SettingName.NAMES.FileUploadBytesUsed,
    // Standard Red Notes: last-sent bookkeeping for scheduled email backups is
    // written only by the server-side trigger job; clients may not mutate it.
    SettingName.NAMES.EmailBackupLastSent,
    // Standard Red Notes: last-run bookkeeping for scheduled Nextcloud backups is
    // written only by the server-side trigger job; clients may not mutate it.
    SettingName.NAMES.NextcloudBackupLastRun,
  ]

  private readonly permissionsAssociatedWithSettings = new Map<string, PermissionName>([
    [SettingName.NAMES.EmailBackupFrequency, PermissionName.DailyEmailBackup],
    [SettingName.NAMES.MuteSignInEmails, PermissionName.SignInAlerts],
  ])

  private readonly defaultSettings = new Map<string, SettingDescription>([
    [
      SettingName.NAMES.MuteMarketingEmails,
      {
        value: MuteMarketingEmailsOption.NotMuted,
        replaceable: false,
      },
    ],
    [
      SettingName.NAMES.LogSessionUserAgent,
      {
        value: LogSessionUserAgentOption.Enabled,
        replaceable: false,
      },
    ],
  ])

  private readonly privateUsernameAccountDefaultSettingsOverwrites = new Map<string, SettingDescription>([
    [
      SettingName.NAMES.LogSessionUserAgent,
      {
        value: LogSessionUserAgentOption.Disabled,
        replaceable: false,
      },
    ],
  ])

  isSettingMutableByClient(settingName: SettingName): boolean {
    if (this.CLIENT_IMMUTABLE_SETTINGS.includes(settingName.value)) {
      return false
    }

    return true
  }

  getSensitivityForSetting(settingName: SettingName): boolean {
    if (this.UNSENSITIVE_SETTINGS.includes(settingName.value)) {
      return false
    }

    return true
  }

  getEncryptionVersionForSetting(settingName: SettingName): EncryptionVersion {
    if (this.UNENCRYPTED_SETTINGS.includes(settingName.value)) {
      return EncryptionVersion.Unencrypted
    }

    return EncryptionVersion.Default
  }

  getPermissionAssociatedWithSetting(settingName: SettingName): PermissionName | undefined {
    if (!this.permissionsAssociatedWithSettings.has(settingName.value)) {
      return undefined
    }

    return this.permissionsAssociatedWithSettings.get(settingName.value)
  }

  getDefaultSettingsAndValuesForNewUser(): Map<string, SettingDescription> {
    return this.defaultSettings
  }

  getDefaultSettingsAndValuesForNewPrivateUsernameAccount(): Map<string, SettingDescription> {
    const defaultPrivateUsernameSettings = new Map(this.defaultSettings)

    for (const privateUsernameAccountDefaultSettingOverwriteKey of this.privateUsernameAccountDefaultSettingsOverwrites.keys()) {
      defaultPrivateUsernameSettings.set(
        privateUsernameAccountDefaultSettingOverwriteKey,
        this.privateUsernameAccountDefaultSettingsOverwrites.get(
          privateUsernameAccountDefaultSettingOverwriteKey,
        ) as SettingDescription,
      )
    }

    return defaultPrivateUsernameSettings
  }
}

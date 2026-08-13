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
    // Standard Red Notes: administrator-managed feature gates are authorization
    // inputs, not user secrets. Cross-service token minting must be able to read
    // their canonical values without mistaking ciphertext for an enabled flag.
    SettingName.NAMES.AiEnabled,
    SettingName.NAMES.AiRequestLimit,
    SettingName.NAMES.CollaborationEnabled,
    SettingName.NAMES.LiveSyncEnabled,
    SettingName.NAMES.EmailBackupFrequency,
    SettingName.NAMES.EmailBackupLastSent,
    SettingName.NAMES.EmailRemindersEnabled,
    // Standard Red Notes: per-user server-OCR opt-in. A plain 'true'/'false' flag
    // carrying no secret; stored unencrypted so the api-gateway can read it without
    // per-user key material when gating a server-OCR request.
    SettingName.NAMES.OcrServerAllowed,
    // Standard Red Notes: Nextcloud scheduled-backup config. Frequency, URL, folder
    // and last-run bookkeeping carry no secret and must be readable by the trigger
    // job without per-user key material, so they are stored unencrypted. The app
    // PASSWORD is deliberately ABSENT here -> it is encrypted at rest (default).
    SettingName.NAMES.NextcloudBackupFrequency,
    SettingName.NAMES.NextcloudBackupUrl,
    SettingName.NAMES.NextcloudBackupFolder,
    SettingName.NAMES.NextcloudBackupLastRun,
    // Delivery receipts contain no credential and can stay unencrypted, but the
    // setting remains private by omission from UNSENSITIVE_SETTINGS below.
    SettingName.NAMES.NextcloudBackupDeliveryState,
    // Standard Red Notes: per-user admin gate for scheduled Nextcloud backups. A
    // plain 'true'/'false' flag carrying no secret; stored unencrypted so the
    // trigger job can read it without per-user key material when gating a backup.
    SettingName.NAMES.NextcloudBackupAllowed,
    // Standard Red Notes: per-user admin gate for the WORKFLOWS (n8n) feature. A
    // plain 'true'/'false' flag carrying no secret; stored unencrypted so
    // cross-service token minting can read it without per-user key material.
    SettingName.NAMES.WorkflowsEnabled,
    SettingName.NAMES.MuteSignInEmails,
    SettingName.NAMES.MuteMarketingEmails,
    SettingName.NAMES.DropboxBackupFrequency,
    SettingName.NAMES.GoogleDriveBackupFrequency,
    SettingName.NAMES.OneDriveBackupFrequency,
    SettingName.NAMES.LogSessionUserAgent,
    // Standard Red Notes: the instance-wide "registration disabled" flag is a plain
    // 'true'/'false' value carrying no secret. It MUST be stored UNENCRYPTED because
    // Register consults it instance-wide with a raw value comparison
    // (SettingRepository.countAllByNameAndValue({ value: 'true' })) and cannot decrypt
    // per-user ciphertext there. Storing it encrypted made that comparison never
    // match, so a persisted "signups off" was silently ignored at registration time.
    SettingName.NAMES.RegistrationDisabled,
  ]

  private readonly UNSENSITIVE_SETTINGS = [
    SettingName.NAMES.AiEnabled,
    SettingName.NAMES.AiRequestLimit,
    SettingName.NAMES.CollaborationEnabled,
    SettingName.NAMES.LiveSyncEnabled,
    SettingName.NAMES.DropboxBackupFrequency,
    SettingName.NAMES.GoogleDriveBackupFrequency,
    SettingName.NAMES.OneDriveBackupFrequency,
    SettingName.NAMES.EmailBackupFrequency,
    SettingName.NAMES.EmailBackupLastSent,
    SettingName.NAMES.EmailRemindersEnabled,
    // Standard Red Notes: per-user server-OCR opt-in must be retrievable by the
    // owning client (to know whether to offer "Run OCR on server") and by the
    // api-gateway gate. It carries no secret, so it is not marked sensitive.
    SettingName.NAMES.OcrServerAllowed,
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
    // Standard Red Notes: per-user admin gate for scheduled Nextcloud backups. The
    // owning client and the admin panel must be able to read it back; it carries no
    // secret, so it is not marked sensitive (getSetting returns its plain value).
    SettingName.NAMES.NextcloudBackupAllowed,
    // Standard Red Notes: per-user admin gate for the WORKFLOWS (n8n) feature.
    // The owning client and the admin panel must be able to read it back; it
    // carries no secret, so it is not marked sensitive.
    SettingName.NAMES.WorkflowsEnabled,
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
    // Standard Red Notes: the instance-wide "registration disabled" flag must be
    // retrievable as a plain value by the admin panel (GET /v1/admin/registration
    // reads it with allowSensitiveRetrieval:false) and consulted unencrypted by
    // Register. It carries no secret, so it is not marked sensitive — otherwise
    // GetSetting refuses the non-sensitive admin read and the panel always shows
    // "signups open".
    SettingName.NAMES.RegistrationDisabled,
  ]

  private readonly CLIENT_IMMUTABLE_SETTINGS = [
    // These gates are controlled by an administrator. Letting the owning client
    // write or delete them would let it restore access after an administrative
    // disable (unset means enabled for AI/collaboration/live sync).
    SettingName.NAMES.AiEnabled,
    SettingName.NAMES.AiRequestLimit,
    SettingName.NAMES.CollaborationEnabled,
    SettingName.NAMES.LiveSyncEnabled,
    SettingName.NAMES.ListedAuthorSecrets,
    SettingName.NAMES.FileUploadBytesLimit,
    SettingName.NAMES.FileUploadBytesUsed,
    // Standard Red Notes: last-sent bookkeeping for scheduled email backups is
    // written only by the server-side trigger job; clients may not mutate it.
    SettingName.NAMES.EmailBackupLastSent,
    // Contains deterministic delivery ids and exact protected attachment
    // references needed for post-provider reconciliation. It is encrypted,
    // sensitive, and writable only by server-side delivery bookkeeping.
    SettingName.NAMES.EmailBackupDeliveryState,
    // Standard Red Notes: last-run bookkeeping for scheduled Nextcloud backups is
    // written only by the server-side trigger job; clients may not mutate it.
    SettingName.NAMES.NextcloudBackupLastRun,
    SettingName.NAMES.NextcloudBackupDeliveryState,
    // Standard Red Notes: the instance-wide "registration disabled" flag is an
    // ADMIN-ONLY control. It must NOT be writable through the ordinary user
    // settings endpoint (BaseSettingsController's user-settings PUT, which lets a
    // user write their OWN settings with checkUserPermissions:true) — otherwise a
    // normal authenticated user could persist REGISTRATION_DISABLED='true' on their
    // own record and disable signups instance-wide (a persistent DoS). Marking it
    // client-immutable makes isSettingMutableByClient() return false so
    // SetSettingValue.userHasPermissionToUpdateSetting() refuses that client write.
    // The admin panel write path (BaseAdminController.setRegistrationFlag) is
    // unaffected: it calls SetSettingValue with checkUserPermissions:false, which
    // bypasses the client-permission check entirely, so the admin can still toggle
    // it. Register additionally only counts admin-owned REGISTRATION_DISABLED rows
    // (see Register.registrationDisabledBySetting), so any stale non-admin row
    // written before this fix is ignored.
    SettingName.NAMES.RegistrationDisabled,
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

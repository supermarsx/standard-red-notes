import 'reflect-metadata'

import { PermissionName } from '@standardnotes/features'

import { SettingsAssociationService } from './SettingsAssociationService'
import { EncryptionVersion } from '../Encryption/EncryptionVersion'
import { SettingDescription } from './SettingDescription'
import { SettingName } from '@standardnotes/domain-core'

describe('SettingsAssociationService', () => {
  const createService = () => new SettingsAssociationService()

  it('should tell if a setting is mutable by the client', () => {
    expect(
      createService().isSettingMutableByClient(SettingName.create(SettingName.NAMES.DropboxBackupFrequency).getValue()),
    ).toBeTruthy()
  })

  it('should tell if a setting is immutable by the client', () => {
    expect(
      createService().isSettingMutableByClient(SettingName.create(SettingName.NAMES.ListedAuthorSecrets).getValue()),
    ).toBeFalsy()
  })

  it('should return default encryption version for a setting which enecryption version is not strictly defined', () => {
    expect(
      createService().getEncryptionVersionForSetting(SettingName.create(SettingName.NAMES.MfaSecret).getValue()),
    ).toEqual(EncryptionVersion.Default)
  })

  it('should return a defined encryption version for a setting which enecryption version is strictly defined', () => {
    expect(
      createService().getEncryptionVersionForSetting(
        SettingName.create(SettingName.NAMES.EmailBackupFrequency).getValue(),
      ),
    ).toEqual(EncryptionVersion.Unencrypted)
  })

  it('should return default sensitivity for a setting which sensitivity is not strictly defined', () => {
    expect(
      createService().getSensitivityForSetting(SettingName.create(SettingName.NAMES.DropboxBackupToken).getValue()),
    ).toBeTruthy()
  })

  it('should return a defined sensitivity for a setting which sensitivity is strictly defined', () => {
    expect(
      createService().getSensitivityForSetting(SettingName.create(SettingName.NAMES.DropboxBackupFrequency).getValue()),
    ).toBeFalsy()
  })

  it('should return the default set of settings for a newly registered user', () => {
    const settings = createService().getDefaultSettingsAndValuesForNewUser()
    const flatSettings = [...(settings as Map<string, SettingDescription>).keys()]
    expect(flatSettings).toEqual(['MUTE_MARKETING_EMAILS', 'LOG_SESSION_USER_AGENT'])
  })

  it('should return the default set of settings for a newly registered vault account', () => {
    const settings = createService().getDefaultSettingsAndValuesForNewPrivateUsernameAccount()
    const flatSettings = [...(settings as Map<string, SettingDescription>).keys()]
    expect(flatSettings).toEqual(['MUTE_MARKETING_EMAILS', 'LOG_SESSION_USER_AGENT'])

    expect(settings.get(SettingName.NAMES.LogSessionUserAgent)?.value).toEqual('disabled')
  })

  it('should return a permission name associated to a given setting', () => {
    expect(
      createService().getPermissionAssociatedWithSetting(
        SettingName.create(SettingName.NAMES.EmailBackupFrequency).getValue(),
      ),
    ).toEqual(PermissionName.DailyEmailBackup)
  })

  it('should not return a permission name if not associated to a given setting', () => {
    expect(
      createService().getPermissionAssociatedWithSetting(SettingName.create(SettingName.NAMES.ExtensionKey).getValue()),
    ).toBeUndefined()
  })

  describe('account recovery escrow (Standard Red Notes, opt-in)', () => {
    it('should be a valid, recognized setting name', () => {
      const result = SettingName.create(SettingName.NAMES.AccountRecoveryEscrow)
      expect(result.isFailed()).toBeFalsy()
      expect(result.getValue().value).toEqual('ACCOUNT_RECOVERY_ESCROW')
    })

    it('should be OFF by default: not part of any default settings for new accounts', () => {
      const newUserSettings = createService().getDefaultSettingsAndValuesForNewUser()
      const newVaultSettings = createService().getDefaultSettingsAndValuesForNewPrivateUsernameAccount()

      expect(newUserSettings.has(SettingName.NAMES.AccountRecoveryEscrow)).toBeFalsy()
      expect(newVaultSettings.has(SettingName.NAMES.AccountRecoveryEscrow)).toBeFalsy()
    })

    it('should be retrievable by the owning client (not server-side sensitive)', () => {
      // Confidentiality of the escrow comes from CLIENT-SIDE encryption, not from
      // server-side gating. The owning client must be able to read it back to run
      // the recovery flow.
      expect(
        createService().getSensitivityForSetting(
          SettingName.create(SettingName.NAMES.AccountRecoveryEscrow).getValue(),
        ),
      ).toBeFalsy()
    })

    it('should be mutable by the client (client creates and deletes the escrow)', () => {
      expect(
        createService().isSettingMutableByClient(
          SettingName.create(SettingName.NAMES.AccountRecoveryEscrow).getValue(),
        ),
      ).toBeTruthy()
    })

    it('should still use default server-side at-rest encryption for the stored ciphertext', () => {
      expect(
        createService().getEncryptionVersionForSetting(
          SettingName.create(SettingName.NAMES.AccountRecoveryEscrow).getValue(),
        ),
      ).toEqual(EncryptionVersion.Default)
    })
  })
})

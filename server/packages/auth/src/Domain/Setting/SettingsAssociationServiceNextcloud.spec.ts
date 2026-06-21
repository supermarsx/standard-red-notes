import 'reflect-metadata'

import { SettingName } from '@standardnotes/domain-core'

import { SettingsAssociationService } from './SettingsAssociationService'
import { EncryptionVersion } from '../Encryption/EncryptionVersion'
import { SettingDescription } from './SettingDescription'

describe('SettingsAssociationService — Nextcloud backup settings (Standard Red Notes)', () => {
  const createService = () => new SettingsAssociationService()

  describe('app password (SENSITIVE / encrypted)', () => {
    const name = SettingName.NAMES.NextcloudBackupAppPassword

    it('is encrypted at rest (default encryption version, not unencrypted)', () => {
      expect(createService().getEncryptionVersionForSetting(SettingName.create(name).getValue())).toEqual(
        EncryptionVersion.Default,
      )
    })

    it('is sensitive (a normal getSetting read returns no value)', () => {
      expect(createService().getSensitivityForSetting(SettingName.create(name).getValue())).toBe(true)
    })

    it('is mutable by the client (the user sets/updates it from the pane)', () => {
      expect(createService().isSettingMutableByClient(SettingName.create(name).getValue())).toBe(true)
    })
  })

  describe('url / folder / frequency (UNENCRYPTED + UNSENSITIVE)', () => {
    const names = [
      SettingName.NAMES.NextcloudBackupUrl,
      SettingName.NAMES.NextcloudBackupFolder,
      SettingName.NAMES.NextcloudBackupFrequency,
    ]

    it.each(names)('%s is stored unencrypted so the trigger job can read it', (name) => {
      expect(createService().getEncryptionVersionForSetting(SettingName.create(name).getValue())).toEqual(
        EncryptionVersion.Unencrypted,
      )
    })

    it.each(names)('%s is unsensitive (readable plain value for the owning client)', (name) => {
      expect(createService().getSensitivityForSetting(SettingName.create(name).getValue())).toBe(false)
    })

    it.each(names)('%s is mutable by the client', (name) => {
      expect(createService().isSettingMutableByClient(SettingName.create(name).getValue())).toBe(true)
    })
  })

  describe('last-run bookkeeping (server-written, CLIENT-IMMUTABLE)', () => {
    const name = SettingName.NAMES.NextcloudBackupLastRun

    it('is stored unencrypted', () => {
      expect(createService().getEncryptionVersionForSetting(SettingName.create(name).getValue())).toEqual(
        EncryptionVersion.Unencrypted,
      )
    })

    it('is unsensitive', () => {
      expect(createService().getSensitivityForSetting(SettingName.create(name).getValue())).toBe(false)
    })

    it('is immutable by the client (server-written only)', () => {
      expect(createService().isSettingMutableByClient(SettingName.create(name).getValue())).toBe(false)
    })
  })

  describe('default OFF', () => {
    const allNextcloudNames = [
      SettingName.NAMES.NextcloudBackupFrequency,
      SettingName.NAMES.NextcloudBackupUrl,
      SettingName.NAMES.NextcloudBackupFolder,
      SettingName.NAMES.NextcloudBackupAppPassword,
      SettingName.NAMES.NextcloudBackupLastRun,
    ]

    it('no Nextcloud backup setting is part of the default settings for new accounts', () => {
      const newUser = createService().getDefaultSettingsAndValuesForNewUser() as Map<string, SettingDescription>
      const newVault = createService().getDefaultSettingsAndValuesForNewPrivateUsernameAccount() as Map<
        string,
        SettingDescription
      >

      for (const name of allNextcloudNames) {
        expect(newUser.has(name)).toBe(false)
        expect(newVault.has(name)).toBe(false)
      }
    })
  })
})

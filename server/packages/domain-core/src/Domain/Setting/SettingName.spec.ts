import { SettingName } from './SettingName'

describe('SettingName — Nextcloud backup settings (Standard Red Notes)', () => {
  describe('valid, recognized setting names', () => {
    const names = [
      ['NextcloudBackupFrequency', 'NEXTCLOUD_BACKUP_FREQUENCY'],
      ['NextcloudBackupUrl', 'NEXTCLOUD_BACKUP_URL'],
      ['NextcloudBackupFolder', 'NEXTCLOUD_BACKUP_FOLDER'],
      ['NextcloudBackupAppPassword', 'NEXTCLOUD_BACKUP_APP_PASSWORD'],
      ['NextcloudBackupLastRun', 'NEXTCLOUD_BACKUP_LAST_RUN'],
    ] as const

    it.each(names)('%s resolves to %s and is creatable', (key, value) => {
      expect((SettingName.NAMES as Record<string, string>)[key]).toEqual(value)
      const result = SettingName.create(value)
      expect(result.isFailed()).toBe(false)
      expect(result.getValue().value).toEqual(value)
    })
  })

  describe('sensitivity classification', () => {
    it('classifies the Nextcloud app password as SENSITIVE', () => {
      expect(SettingName.create(SettingName.NAMES.NextcloudBackupAppPassword).getValue().isSensitive()).toBe(true)
    })

    it('does NOT classify url / folder / frequency / last-run as sensitive', () => {
      expect(SettingName.create(SettingName.NAMES.NextcloudBackupUrl).getValue().isSensitive()).toBe(false)
      expect(SettingName.create(SettingName.NAMES.NextcloudBackupFolder).getValue().isSensitive()).toBe(false)
      expect(SettingName.create(SettingName.NAMES.NextcloudBackupFrequency).getValue().isSensitive()).toBe(false)
      expect(SettingName.create(SettingName.NAMES.NextcloudBackupLastRun).getValue().isSensitive()).toBe(false)
    })

    it('keeps the existing sensitive settings sensitive', () => {
      expect(SettingName.create(SettingName.NAMES.MfaSecret).getValue().isSensitive()).toBe(true)
      expect(SettingName.create(SettingName.NAMES.ExtensionKey).getValue().isSensitive()).toBe(true)
    })

    it('does not treat any Nextcloud backup setting as a subscription setting', () => {
      expect(SettingName.create(SettingName.NAMES.NextcloudBackupAppPassword).getValue().isASubscriptionSetting()).toBe(
        false,
      )
      expect(SettingName.create(SettingName.NAMES.NextcloudBackupFrequency).getValue().isASubscriptionSetting()).toBe(
        false,
      )
    })
  })
})

describe('SettingName subscription classification', () => {
  it('classifies upload limits as regular-only subscription settings', () => {
    const name = SettingName.create(SettingName.NAMES.FileUploadBytesLimit).getValue()

    expect(name.isASubscriptionSetting()).toBe(true)
    expect(name.isARegularOnlySubscriptionSetting()).toBe(true)
    expect(name.isASharedAndRegularOnlySubscriptionSetting()).toBe(false)
  })

  it('classifies muted sign-in emails as shared-and-regular subscription settings', () => {
    const name = SettingName.create(SettingName.NAMES.MuteSignInEmails).getValue()

    expect(name.isASubscriptionSetting()).toBe(true)
    expect(name.isARegularOnlySubscriptionSetting()).toBe(false)
    expect(name.isASharedAndRegularOnlySubscriptionSetting()).toBe(true)
  })

  it('rejects unknown setting names', () => {
    const result = SettingName.create('NOT_A_SETTING')

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe('Invalid setting name: NOT_A_SETTING')
  })
})

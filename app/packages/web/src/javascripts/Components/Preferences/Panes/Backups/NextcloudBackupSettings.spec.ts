import { NextcloudBackupSettingName } from './NextcloudBackupSettings'

describe('NextcloudBackupSettingName', () => {
  it('matches the server setting-name contract', () => {
    expect(NextcloudBackupSettingName).toEqual({
      Frequency: 'NEXTCLOUD_BACKUP_FREQUENCY',
      Url: 'NEXTCLOUD_BACKUP_URL',
      Folder: 'NEXTCLOUD_BACKUP_FOLDER',
      AppPassword: 'NEXTCLOUD_BACKUP_APP_PASSWORD',
    })
  })
})

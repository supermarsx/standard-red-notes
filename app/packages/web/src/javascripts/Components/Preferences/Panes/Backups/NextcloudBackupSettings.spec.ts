import {
  getNextcloudBackupValidationError,
  NextcloudBackupDraft,
  NextcloudBackupFrequency,
  NextcloudBackupSettingName,
  saveNextcloudBackupSettings,
} from './NextcloudBackupSettings'

const completeDraft: NextcloudBackupDraft = {
  frequency: NextcloudBackupFrequency.Daily,
  persistedFrequency: NextcloudBackupFrequency.Disabled,
  url: 'https://cloud.example',
  folder: 'Backups/Standard Notes',
  appPassword: 'new app password',
  appPasswordIsSet: false,
}

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

describe('getNextcloudBackupValidationError', () => {
  it.each([
    [{ url: 'http://cloud.example' }, /require HTTPS/],
    [{ url: 'https://user:password@cloud.example' }, /Remove credentials/],
    [{ url: 'https://cloud.example?tenant=one' }, /without a query/],
    [{ url: 'https://cloud.example#settings' }, /without a query/],
    [{ folder: 'Backups//Notes' }, /safe folder path/],
    [{ folder: 'Backups/../Notes' }, /safe folder path/],
    [{ appPassword: ' password ' }, /leading or trailing whitespace/],
    [{ url: '' }, /HTTPS Nextcloud base URL/],
    [{ appPassword: '', appPasswordIsSet: false }, /dedicated, low-privilege/],
  ] as Array<[Partial<NextcloudBackupDraft>, RegExp]>)(
    'rejects unsafe or incomplete configuration %#',
    (change, error) => {
      expect(getNextcloudBackupValidationError({ ...completeDraft, ...change })).toMatch(error)
    },
  )

  it('allows an existing write-only app password to satisfy an enabled configuration', () => {
    expect(
      getNextcloudBackupValidationError({ ...completeDraft, appPassword: '', appPasswordIsSet: true }),
    ).toBeUndefined()
  })

  it('preserves an empty optional folder as a valid WebDAV account-root destination', () => {
    expect(getNextcloudBackupValidationError({ ...completeDraft, folder: '' })).toBeUndefined()
  })

  it('allows an incomplete draft only while backups remain disabled', () => {
    expect(
      getNextcloudBackupValidationError({
        ...completeDraft,
        frequency: NextcloudBackupFrequency.Disabled,
        url: '',
        folder: '',
        appPassword: '',
      }),
    ).toBeUndefined()
  })
})

describe('saveNextcloudBackupSettings', () => {
  it('writes URL, folder, exact app password, and activation frequency in security order', async () => {
    const update = jest.fn().mockResolvedValue(true)

    const result = await saveNextcloudBackupSettings(completeDraft, update)

    expect(result).toEqual({
      success: true,
      appPasswordSaved: true,
      effectiveFrequency: NextcloudBackupFrequency.Daily,
    })
    expect(update.mock.calls).toEqual([
      [NextcloudBackupSettingName.Url, 'https://cloud.example'],
      [NextcloudBackupSettingName.Folder, 'Backups/Standard Notes'],
      [NextcloudBackupSettingName.AppPassword, 'new app password', true],
      [NextcloudBackupSettingName.Frequency, NextcloudBackupFrequency.Daily],
    ])
  })

  it('keeps an existing app password untouched and still writes frequency last', async () => {
    const update = jest.fn().mockResolvedValue(true)

    await saveNextcloudBackupSettings({ ...completeDraft, appPassword: '', appPasswordIsSet: true }, update)

    expect(update.mock.calls).toEqual([
      [NextcloudBackupSettingName.Url, 'https://cloud.example'],
      [NextcloudBackupSettingName.Folder, 'Backups/Standard Notes'],
      [NextcloudBackupSettingName.Frequency, NextcloudBackupFrequency.Daily],
    ])
  })

  it('disables an active schedule before changing any destination field, then reactivates last', async () => {
    const update = jest.fn().mockResolvedValue(true)

    const result = await saveNextcloudBackupSettings(
      {
        ...completeDraft,
        frequency: NextcloudBackupFrequency.Weekly,
        persistedFrequency: NextcloudBackupFrequency.Daily,
      },
      update,
    )

    expect(result.effectiveFrequency).toBe(NextcloudBackupFrequency.Weekly)
    expect(update.mock.calls).toEqual([
      [NextcloudBackupSettingName.Frequency, NextcloudBackupFrequency.Disabled],
      [NextcloudBackupSettingName.Url, 'https://cloud.example'],
      [NextcloudBackupSettingName.Folder, 'Backups/Standard Notes'],
      [NextcloudBackupSettingName.AppPassword, 'new app password', true],
      [NextcloudBackupSettingName.Frequency, NextcloudBackupFrequency.Weekly],
    ])
  })

  it('stops before destination mutation if the fail-closed pre-disable write fails', async () => {
    const update = jest.fn().mockResolvedValue(false)

    const result = await saveNextcloudBackupSettings(
      { ...completeDraft, persistedFrequency: NextcloudBackupFrequency.Daily },
      update,
    )

    expect(result).toMatchObject({
      success: false,
      effectiveFrequency: NextcloudBackupFrequency.Daily,
      failedSetting: NextcloudBackupSettingName.Frequency,
    })
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('returns disabled as the UI-visible effective frequency when a destination write fails after pre-disable', async () => {
    const update = jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    const result = await saveNextcloudBackupSettings(
      { ...completeDraft, persistedFrequency: NextcloudBackupFrequency.Daily },
      update,
    )

    expect(result).toMatchObject({
      success: false,
      effectiveFrequency: NextcloudBackupFrequency.Disabled,
      failedSetting: NextcloudBackupSettingName.Url,
    })
    expect(update.mock.calls).toEqual([
      [NextcloudBackupSettingName.Frequency, NextcloudBackupFrequency.Disabled],
      [NextcloudBackupSettingName.Url, 'https://cloud.example'],
    ])
  })

  it('does not redundantly write disabled after safely disabling an active schedule', async () => {
    const update = jest.fn().mockResolvedValue(true)

    const result = await saveNextcloudBackupSettings(
      {
        ...completeDraft,
        frequency: NextcloudBackupFrequency.Disabled,
        persistedFrequency: NextcloudBackupFrequency.Daily,
      },
      update,
    )

    expect(result).toMatchObject({ success: true, effectiveFrequency: NextcloudBackupFrequency.Disabled })
    expect(update.mock.calls.map(([settingName]) => settingName)).toEqual([
      NextcloudBackupSettingName.Frequency,
      NextcloudBackupSettingName.Url,
      NextcloudBackupSettingName.Folder,
      NextcloudBackupSettingName.AppPassword,
    ])
  })

  it.each([
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
  ])('short-circuits after write %i fails', async (failingWrite, expectedCalls) => {
    const update = jest.fn().mockImplementation(async () => update.mock.calls.length - 1 !== failingWrite)

    const result = await saveNextcloudBackupSettings(completeDraft, update)

    expect(result.success).toBe(false)
    expect(result.effectiveFrequency).toBe(NextcloudBackupFrequency.Disabled)
    expect(update).toHaveBeenCalledTimes(expectedCalls)
    expect(update.mock.calls.at(-1)?.[0]).toBe(
      [
        NextcloudBackupSettingName.Url,
        NextcloudBackupSettingName.Folder,
        NextcloudBackupSettingName.AppPassword,
        NextcloudBackupSettingName.Frequency,
      ][failingWrite],
    )
  })

  it('reports a persisted app password if the final frequency write fails', async () => {
    const update = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    await expect(saveNextcloudBackupSettings(completeDraft, update)).resolves.toEqual({
      success: false,
      appPasswordSaved: true,
      effectiveFrequency: NextcloudBackupFrequency.Disabled,
      failedSetting: NextcloudBackupSettingName.Frequency,
    })
  })

  it('validates the whole draft before the first write', async () => {
    const update = jest.fn().mockResolvedValue(true)

    const result = await saveNextcloudBackupSettings({ ...completeDraft, url: 'http://cloud.example' }, update)

    expect(result).toMatchObject({
      success: false,
      effectiveFrequency: NextcloudBackupFrequency.Disabled,
      validationError: expect.stringMatching(/HTTPS/),
    })
    expect(update).not.toHaveBeenCalled()
  })
})

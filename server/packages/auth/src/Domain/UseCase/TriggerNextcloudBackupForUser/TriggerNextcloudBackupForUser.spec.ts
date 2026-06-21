import 'reflect-metadata'

import { Result, SettingName } from '@standardnotes/domain-core'
import { NextcloudBackupFrequency } from '@standardnotes/settings'
import { DomainEventPublisherInterface } from '@standardnotes/domain-events'

import { GetSetting } from '../GetSetting/GetSetting'
import { GetUserKeyParams } from '../GetUserKeyParams/GetUserKeyParams'
import { DomainEventFactoryInterface } from '../../Event/DomainEventFactoryInterface'
import { TriggerNextcloudBackupForUser } from './TriggerNextcloudBackupForUser'

describe('TriggerNextcloudBackupForUser (Standard Red Notes)', () => {
  let getUserKeyParams: GetUserKeyParams
  let getSetting: GetSetting
  let domainEventPublisher: DomainEventPublisherInterface
  let domainEventFactory: DomainEventFactoryInterface

  const userUuid = '00000000-0000-0000-0000-000000000001'

  // Per-setting values the user has configured. Override per test.
  let settingValues: Record<string, string | null>
  // Capture how the app password is retrieved to assert it stays sensitive.
  let appPasswordRetrieval: { allowSensitiveRetrieval?: boolean } | null

  const createUseCase = () =>
    new TriggerNextcloudBackupForUser(getUserKeyParams, getSetting, domainEventPublisher, domainEventFactory)

  beforeEach(() => {
    settingValues = {
      [SettingName.NAMES.NextcloudBackupAllowed]: 'true',
      [SettingName.NAMES.NextcloudBackupFrequency]: NextcloudBackupFrequency.Daily,
      [SettingName.NAMES.NextcloudBackupUrl]: 'https://cloud.example.com/remote.php/dav',
      [SettingName.NAMES.NextcloudBackupFolder]: 'backups',
      [SettingName.NAMES.NextcloudBackupAppPassword]: 'secret-app-password',
    }
    appPasswordRetrieval = null

    getSetting = {} as jest.Mocked<GetSetting>
    getSetting.execute = jest
      .fn()
      .mockImplementation(async (dto: { settingName: string; allowSensitiveRetrieval?: boolean }) => {
        if (dto.settingName === SettingName.NAMES.NextcloudBackupAppPassword) {
          appPasswordRetrieval = { allowSensitiveRetrieval: dto.allowSensitiveRetrieval }
        }
        const value = settingValues[dto.settingName]
        if (value === undefined || value === null) {
          return Result.fail(`Setting ${dto.settingName} not found`)
        }
        return Result.ok({ decryptedValue: value })
      })

    getUserKeyParams = {} as jest.Mocked<GetUserKeyParams>
    getUserKeyParams.execute = jest.fn().mockResolvedValue({ keyParams: { identifier: 'user@test' } })

    domainEventFactory = {} as jest.Mocked<DomainEventFactoryInterface>
    domainEventFactory.createNextcloudBackupRequestedEvent = jest.fn().mockReturnValue({ type: 'NEXTCLOUD_BACKUP_REQUESTED' })

    domainEventPublisher = {} as jest.Mocked<DomainEventPublisherInterface>
    domainEventPublisher.publish = jest.fn().mockResolvedValue(undefined)
  })

  it('proceeds and publishes the backup-requested event when the admin allow flag is true', async () => {
    const result = await createUseCase().execute({ userUuid })

    expect(result.isFailed()).toBe(false)
    expect(domainEventPublisher.publish).toHaveBeenCalledTimes(1)
    expect(domainEventFactory.createNextcloudBackupRequestedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userUuid,
        nextcloudUrl: 'https://cloud.example.com/remote.php/dav',
        nextcloudFolder: 'backups',
        nextcloudAppPassword: 'secret-app-password',
      }),
    )
  })

  it('skips (fails) when the admin allow flag is not set, before reading completeness', async () => {
    settingValues[SettingName.NAMES.NextcloudBackupAllowed] = null

    const result = await createUseCase().execute({ userUuid })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toContain('not allowed Nextcloud backups by an administrator')
    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
  })

  it('skips (fails) when the admin allow flag is explicitly false', async () => {
    settingValues[SettingName.NAMES.NextcloudBackupAllowed] = 'false'

    const result = await createUseCase().execute({ userUuid })

    expect(result.isFailed()).toBe(true)
    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
  })

  it('retrieves the app password as a SENSITIVE setting (allowSensitiveRetrieval: true)', async () => {
    await createUseCase().execute({ userUuid })

    expect(appPasswordRetrieval).not.toBeNull()
    expect(appPasswordRetrieval?.allowSensitiveRetrieval).toBe(true)
  })

  it('does not read the app password at all when the allow flag gates the backup off', async () => {
    settingValues[SettingName.NAMES.NextcloudBackupAllowed] = 'false'

    await createUseCase().execute({ userUuid })

    // Gated off before any completeness/credential read -> password never touched.
    expect(appPasswordRetrieval).toBeNull()
  })
})

import { Logger } from 'winston'
import { SettingRepositoryInterface } from '../../Setting/SettingRepositoryInterface'
import { TriggerEmailBackupForUser } from '../TriggerEmailBackupForUser/TriggerEmailBackupForUser'
import { GetSetting } from '../GetSetting/GetSetting'
import { TriggerEmailBackupForAllUsers } from './TriggerEmailBackupForAllUsers'
import { EncryptionVersion } from '../../Encryption/EncryptionVersion'
import { TimerInterface } from '@standardnotes/time'

import { Setting } from '../../Setting/Setting'
import { Result, SettingName, Timestamps, Uuid } from '@standardnotes/domain-core'

describe('TriggerEmailBackupForAllUsers', () => {
  let settingRepository: SettingRepositoryInterface
  let triggerEmailBackupForUserUseCase: TriggerEmailBackupForUser
  let getSetting: GetSetting
  let timer: TimerInterface
  let logger: Logger
  let emailBackupsEnabled: boolean
  let emailDeliveryConfigured: boolean

  const NOW_MICROS = 1_700_000_000_000_000
  const NOW_MS = 1_700_000_000_000
  const USER_UUID = '00000000-0000-0000-0000-000000000000'

  const createUseCase = () =>
    new TriggerEmailBackupForAllUsers(
      settingRepository,
      triggerEmailBackupForUserUseCase,
      getSetting,
      timer,
      logger,
      emailBackupsEnabled,
      emailDeliveryConfigured,
    )

  beforeEach(() => {
    const setting = Setting.create({
      name: SettingName.NAMES.EmailBackupFrequency,
      value: null,
      serverEncryptionVersion: EncryptionVersion.Default,
      userUuid: Uuid.create('00000000-0000-0000-0000-000000000000').getValue(),
      sensitive: false,
      timestamps: Timestamps.create(123, 123).getValue(),
    }).getValue()

    settingRepository = {} as jest.Mocked<SettingRepositoryInterface>
    settingRepository.countAllByNameAndValue = jest.fn().mockResolvedValue(1)
    settingRepository.findAllByNameAndValue = jest.fn().mockResolvedValue([setting])

    triggerEmailBackupForUserUseCase = {} as jest.Mocked<TriggerEmailBackupForUser>
    triggerEmailBackupForUserUseCase.execute = jest.fn().mockResolvedValue(Result.ok())

    getSetting = {} as jest.Mocked<GetSetting>
    // Default: user has never received a backup -> due.
    getSetting.execute = jest.fn().mockResolvedValue(Result.fail('not found'))

    timer = {} as jest.Mocked<TimerInterface>
    timer.getTimestampInMicroseconds = jest.fn().mockReturnValue(NOW_MICROS)
    timer.convertMicrosecondsToMilliseconds = jest.fn().mockReturnValue(NOW_MS)

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
    logger.info = jest.fn()
    logger.warn = jest.fn()

    emailBackupsEnabled = true
    emailDeliveryConfigured = true
  })

  it('triggers an email backup for a due user and leaves last-sent to confirmed delivery', async () => {
    const result = await createUseCase().execute({ backupFrequency: 'daily' })

    expect(result.isFailed()).toBeFalsy()
    expect(triggerEmailBackupForUserUseCase.execute).toHaveBeenCalled()
  })

  it('no-ops when the operator has not enabled email backups', async () => {
    emailBackupsEnabled = false

    const result = await createUseCase().execute({ backupFrequency: 'daily' })

    expect(result.isFailed()).toBeFalsy()
    expect(settingRepository.countAllByNameAndValue).not.toHaveBeenCalled()
    expect(triggerEmailBackupForUserUseCase.execute).not.toHaveBeenCalled()
  })

  it('no-ops when email delivery (SMTP) is not configured', async () => {
    emailDeliveryConfigured = false

    const result = await createUseCase().execute({ backupFrequency: 'daily' })

    expect(result.isFailed()).toBeFalsy()
    expect(triggerEmailBackupForUserUseCase.execute).not.toHaveBeenCalled()
  })

  it('skips a user whose last backup was sent too recently to be due', async () => {
    const recentSetting = Setting.create({
      name: SettingName.NAMES.EmailBackupLastSent,
      value: String(NOW_MS - 60 * 60 * 1000), // 1 hour ago
      serverEncryptionVersion: EncryptionVersion.Unencrypted,
      userUuid: Uuid.create('00000000-0000-0000-0000-000000000000').getValue(),
      sensitive: false,
      timestamps: Timestamps.create(123, 123).getValue(),
    }).getValue()

    getSetting.execute = jest
      .fn()
      .mockResolvedValue(Result.ok({ setting: recentSetting, decryptedValue: String(NOW_MS - 60 * 60 * 1000) }))

    const result = await createUseCase().execute({ backupFrequency: 'daily' })

    expect(result.isFailed()).toBeFalsy()
    expect(triggerEmailBackupForUserUseCase.execute).not.toHaveBeenCalled()
  })

  it('continues the scheduler pass when a user backup request fails', async () => {
    triggerEmailBackupForUserUseCase.execute = jest.fn().mockResolvedValue(Result.fail('SMTP unavailable'))

    const result = await createUseCase().execute({ backupFrequency: 'daily' })

    expect(result.isFailed()).toBeFalsy()
    expect(logger.error).toHaveBeenCalledWith('Failed to trigger an email backup for a user.', {
      userId: USER_UUID,
    })
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('SMTP unavailable')
    expect(logger.error).toHaveBeenCalledWith('Failed to trigger email backup for 1 users')
  })

  it.each([
    ['an empty', ''],
    ['a malformed', 'not-a-timestamp'],
  ])('treats %s last-sent value as never sent', async (_description, decryptedValue) => {
    const lastSentSetting = Setting.create({
      name: SettingName.NAMES.EmailBackupLastSent,
      value: decryptedValue,
      serverEncryptionVersion: EncryptionVersion.Unencrypted,
      userUuid: Uuid.create(USER_UUID).getValue(),
      sensitive: false,
      timestamps: Timestamps.create(123, 123).getValue(),
    }).getValue()

    getSetting.execute = jest.fn().mockResolvedValue(Result.ok({ setting: lastSentSetting, decryptedValue }))

    const result = await createUseCase().execute({ backupFrequency: 'daily' })

    expect(result.isFailed()).toBeFalsy()
    expect(triggerEmailBackupForUserUseCase.execute).toHaveBeenCalledWith({ userUuid: USER_UUID })
  })
})

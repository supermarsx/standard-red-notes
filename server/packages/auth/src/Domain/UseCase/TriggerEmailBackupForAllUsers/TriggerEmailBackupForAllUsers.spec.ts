import { Logger } from 'winston'
import { SettingRepositoryInterface } from '../../Setting/SettingRepositoryInterface'
import { TriggerEmailBackupForUser } from '../TriggerEmailBackupForUser/TriggerEmailBackupForUser'
import { GetSetting } from '../GetSetting/GetSetting'
import { SetSettingValue } from '../SetSettingValue/SetSettingValue'
import { TriggerEmailBackupForAllUsers } from './TriggerEmailBackupForAllUsers'
import { EncryptionVersion } from '../../Encryption/EncryptionVersion'
import { TimerInterface } from '@standardnotes/time'

import { Setting } from '../../Setting/Setting'
import { Result, SettingName, Timestamps, Uuid } from '@standardnotes/domain-core'

describe('TriggerEmailBackupForAllUsers', () => {
  let settingRepository: SettingRepositoryInterface
  let triggerEmailBackupForUserUseCase: TriggerEmailBackupForUser
  let getSetting: GetSetting
  let setSettingValue: SetSettingValue
  let timer: TimerInterface
  let logger: Logger
  let emailBackupsEnabled: boolean
  let emailDeliveryConfigured: boolean

  const NOW_MICROS = 1_700_000_000_000_000
  const NOW_MS = 1_700_000_000_000

  const createUseCase = () =>
    new TriggerEmailBackupForAllUsers(
      settingRepository,
      triggerEmailBackupForUserUseCase,
      getSetting,
      setSettingValue,
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

    setSettingValue = {} as jest.Mocked<SetSettingValue>
    setSettingValue.execute = jest.fn().mockResolvedValue(Result.ok({} as Setting))

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

  it('triggers email backup for a due user and records last-sent', async () => {
    const result = await createUseCase().execute({ backupFrequency: 'daily' })

    expect(result.isFailed()).toBeFalsy()
    expect(triggerEmailBackupForUserUseCase.execute).toHaveBeenCalled()
    expect(setSettingValue.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        settingName: SettingName.NAMES.EmailBackupLastSent,
        value: String(NOW_MS),
        checkUserPermissions: false,
      }),
    )
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
    expect(setSettingValue.execute).not.toHaveBeenCalled()
  })
})
